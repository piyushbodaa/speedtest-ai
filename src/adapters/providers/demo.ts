import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { abortErrorFromSignal, TargetFailedError } from '../../core/errors.js';
import { estimateTokens, StreamTokenCounter } from '../../core/tokenizer.js';
import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';

export type DemoProfileName = 'frontier' | 'flash' | 'reasoning' | 'local' | 'buffered';

interface DemoProfileSpec {
  modelName: string;
  bootMs: number;
  pingMs: number;
  decodeTps: number;
  prefillTps: number;
  toolLoopOverheadMs: number;
  hasThinking: boolean;
  /** Emits the whole answer in one piece, like a CLI without a streaming mode. */
  buffered?: boolean;
}

const DEMO_PROFILES: Record<DemoProfileName, DemoProfileSpec> = {
  flash: {
    modelName: 'demo-flash-v2',
    bootMs: 45,
    pingMs: 145,
    decodeTps: 168,
    prefillTps: 8400,
    toolLoopOverheadMs: 360,
    hasThinking: false,
  },
  frontier: {
    modelName: 'demo-frontier-sonnet',
    bootMs: 70,
    pingMs: 340,
    decodeTps: 78,
    prefillTps: 4200,
    toolLoopOverheadMs: 780,
    hasThinking: false,
  },
  reasoning: {
    modelName: 'demo-reasoning-r1',
    bootMs: 85,
    pingMs: 480,
    decodeTps: 62,
    prefillTps: 3600,
    toolLoopOverheadMs: 920,
    hasThinking: true,
  },
  local: {
    modelName: 'demo-local-q4',
    bootMs: 35,
    pingMs: 210,
    decodeTps: 36,
    prefillTps: 620,
    toolLoopOverheadMs: 540,
    hasThinking: false,
  },
  buffered: {
    modelName: 'demo-buffered-b1',
    bootMs: 60,
    pingMs: 300,
    decodeTps: 90,
    prefillTps: 4000,
    toolLoopOverheadMs: 600,
    hasThinking: false,
    buffered: true,
  },
};

export const DEMO_PROFILE_NAMES = Object.keys(DEMO_PROFILES) as DemoProfileName[];

export function isDemoProfileName(value: string): value is DemoProfileName {
  return Object.prototype.hasOwnProperty.call(DEMO_PROFILES, value);
}

const DEMO_SENTENCES = [
  '1. Packet-switched networks divide application payloads into bounded datagrams carrying source and destination routing headers.',
  '2. Edge switches inspect forwarding tables using longest-prefix matching across ternary content-addressable memory banks.',
  '3. Optical transceivers modulate laser phase and amplitude across dense wavelength-division fiber channels.',
  '4. Undersea repeaters amplify attenuated light pulses every eighty kilometers without converting signals back to electrical form.',
  '5. Autonomous systems exchange reachability prefixes through Border Gateway Protocol peering sessions over TCP.',
  '6. Congestion control loops infer bottleneck queue depth from round-trip delay inflation and explicit packet drops.',
  '7. Sender windows ramp exponentially during slow start until reaching the estimated bandwidth-delay product threshold.',
  '8. Additive increase and multiplicative decrease stabilize competing flows sharing congested backbone links.',
  '9. Modern BBR pacing spaces outgoing packets according to measured delivery rate rather than waiting for bufferbloat.',
  '10. Selective acknowledgments allow receivers to report out-of-order segments while avoiding redundant retransmissions.',
  '11. Active queue management algorithms signal early congestion marks before tail-drop oscillations stall throughput.',
  '12. Equal-cost multipath hashing distributes parallel flows across redundant spine-and-leaf fabric uplinks.',
  '13. TLS session resumption compresses cryptographic handshakes into a single round trip at the server edge.',
  '14. Anycast DNS resolvers steer client connections toward the topologically nearest point of presence.',
  '15. QUIC multiplexes independent byte streams over UDP to eliminate head-of-line blocking under packet loss.',
  '16. Receive-side scaling spreads packet descriptor processing across dedicated CPU cores and cache lines.',
  '17. Kernel bypass engines map NIC ring buffers directly into user-space memory for sub-microsecond forwarding.',
  '18. Continuous telemetry probes correlate jitter spikes with microburst queuing across regional transit hops.',
];

const DEMO_CLAUSES = [
  'while downstream monitors keep recording latency, loss and reordering for every hop',
  'so that operators can compare measured behaviour against the capacity plan each week',
  'which keeps throughput stable even when several heavy flows start at the same moment',
  'and this is repeated continuously as link conditions change along the selected path',
  'until the receiver confirms delivery and the sender can release its buffered copy',
];

/** Numbered sentences of about 20 words, as many as the download prompt asks for. */
function demoAnswer(prompt: string): string {
  const requested = Number(prompt.match(/from 1 to (\d+)/)?.[1] ?? DEMO_SENTENCES.length);
  const count = Math.max(1, Math.min(200, requested));
  const sentences: string[] = [];
  for (let i = 0; i < count; i++) {
    const base = DEMO_SENTENCES[i % DEMO_SENTENCES.length].replace(/^\d+\.\s*/, '').replace(/\.$/, '');
    sentences.push(`${i + 1}. ${base}, ${DEMO_CLAUSES[i % DEMO_CLAUSES.length]}.`);
  }
  return sentences.join(' ');
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortErrorFromSignal(signal));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortErrorFromSignal(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function jitteredDelay(baseMs: number, spread = 0.14): number {
  const factor = 1 + (Math.random() * 2 - 1) * spread;
  return Math.max(1, Math.round(baseMs * factor));
}

export interface DemoAdapterOptions {
  /** Multiplies every simulated delay; values below 1 make the simulator faster (used by tests). */
  timeScale?: number;
}

export function createDemoAdapter(
  defaultProfile: DemoProfileName = 'frontier',
  options: DemoAdapterOptions = {}
): SpeedtestAdapter {
  if (!isDemoProfileName(defaultProfile)) {
    throw new TargetFailedError(
      `Unknown demo profile "${defaultProfile}". Valid profiles: ${DEMO_PROFILE_NAMES.join(', ')}`,
      { kind: 'model' }
    );
  }
  const scale = options.timeScale ?? 1;

  return {
    id: 'demo',
    name: 'Demo Simulator',
    category: 'demo',
    tier: 'verified',
    supportsToolLoop: true,
    defaultModel: defaultProfile,
    notes: ['simulated data, not a real model'],
    async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
      if (req.model && !isDemoProfileName(req.model)) {
        throw new TargetFailedError(
          `Unknown demo profile "${req.model}". Valid profiles: ${DEMO_PROFILE_NAMES.join(', ')}`,
          { kind: 'model' }
        );
      }
      const spec = DEMO_PROFILES[(req.model as DemoProfileName | undefined) ?? defaultProfile];
      const sleep = (ms: number, spread?: number) =>
        abortableSleep(jitteredDelay(ms * scale, spread), req.signal);

      yield { kind: 'start' };
      await sleep(spec.bootMs, 0.1);
      yield { kind: 'init', model: spec.modelName };

      const inputTokens = Math.round(estimateTokens(req.prompt) * 1.2);
      const usage = (text: string, extra: Partial<AdapterStreamChunk> = {}): AdapterStreamChunk => ({
        kind: 'terminal',
        model: spec.modelName,
        inputTokens,
        outputTokens: Math.round(estimateTokens(text) * 1.3),
        ...extra,
      });

      if (req.phase === 'ping') {
        await sleep(spec.pingMs - spec.bootMs, 0.12);
        yield { kind: 'text', text: 'PONG' };
        yield usage('PONG');
        return;
      }

      if (req.phase === 'upload') {
        const prefillMs = Math.max(120, Math.round((estimateTokens(req.prompt) / spec.prefillTps) * 1000));
        await sleep(spec.pingMs - spec.bootMs + prefillMs, 0.05);
        const expected = req.prompt.match(/marker=(VERIFY-[A-Z0-9]+)/)?.[1] ?? 'VERIFY-000000';
        yield { kind: 'text', text: expected };
        yield usage(expected);
        return;
      }

      if (req.phase === 'tool_loop') {
        await sleep(spec.pingMs * 0.6, 0.1);
        yield { kind: 'tool_call', toolName: 'Read' };
        let content = 'PROBE-DEMO';
        if (req.cwd) {
          try {
            content = (await fs.readFile(path.join(req.cwd, 'probe.txt'), 'utf8')).trim();
          } catch {
            // Keep the placeholder; the run then fails verification, as a real CLI would.
          }
        }
        await sleep(spec.toolLoopOverheadMs, 0.1);
        yield { kind: 'tool_result', toolName: 'Read', text: content };
        yield { kind: 'text', text: content };
        yield usage(content, { inputTokens: inputTokens + 32 });
        return;
      }

      await sleep(spec.pingMs - spec.bootMs, 0.12);
      const fullText = demoAnswer(req.prompt);

      if (spec.buffered) {
        await sleep((estimateTokens(fullText) / spec.decodeTps) * 1000, 0.05);
        yield { kind: 'text', text: fullText };
        yield usage(fullText);
        return;
      }

      let reasoningTokens = 0;
      if (spec.hasThinking) {
        yield { kind: 'activity' };
        const thoughtWords =
          'Planning concise numbered explanation covering framing, switching, optical modulation, routing, and congestion control.'.split(
            ' '
          );
        for (const word of thoughtWords) {
          const piece = `${word} `;
          const tok = estimateTokens(piece);
          reasoningTokens += tok;
          yield { kind: 'thinking', text: piece };
          await sleep((tok / spec.decodeTps) * 1000, 0.25);
        }
      }

      const words = fullText.split(' ');
      const counter = new StreamTokenCounter();
      const streamStartMs = performance.now();
      const msPerToken = (1000 / spec.decodeTps) * scale;
      // Small 1-2 word pieces, like real SSE token frames, paced against an absolute timeline so
      // timer overshoot does not accumulate and the simulated rate matches the profile.
      for (let i = 0; i < words.length; i += 2) {
        const slice = words.slice(i, i + 2).join(' ') + (i + 2 < words.length ? ' ' : '');
        const added = counter.push(slice);
        if (i > 0) {
          const wobble = (Math.random() * 2 - 1) * 0.28 * added * msPerToken;
          const dueMs = streamStartMs + counter.total * msPerToken + wobble;
          await abortableSleep(Math.max(0, dueMs - performance.now()), req.signal);
        }
        yield { kind: 'text', text: slice };
      }

      yield usage(fullText, reasoningTokens > 0 ? { reasoningTokens } : {});
    },
  };
}
