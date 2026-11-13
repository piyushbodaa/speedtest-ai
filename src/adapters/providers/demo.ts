import fs from 'node:fs/promises';
import path from 'node:path';
import type { AdapterInvokeRequest, AdapterStreamChunk, SpeedtestAdapter } from '../../types.js';
import { estimateTokens } from '../../core/tokenizer.js';

export type DemoProfileName = 'frontier' | 'flash' | 'reasoning' | 'local';

interface DemoProfileSpec {
  modelName: string;
  bootMs: number;
  pingMs: number;
  decodeTps: number;
  prefillTps: number;
  toolLoopOverheadMs: number;
  hasThinking: boolean;
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
};

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

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function jitteredDelay(baseMs: number, spread = 0.14): number {
  const factor = 1 + (Math.random() * 2 - 1) * spread;
  return Math.max(4, Math.round(baseMs * factor));
}

export function createDemoAdapter(defaultProfile: DemoProfileName = 'frontier'): SpeedtestAdapter {
  return {
    id: 'demo',
    name: 'Demo Simulator',
    category: 'demo',
    supportsToolLoop: true,
    defaultModel: defaultProfile,
    async *stream(req: AdapterInvokeRequest): AsyncGenerator<AdapterStreamChunk, void, unknown> {
      const profileKey = (
        req.model && req.model in DEMO_PROFILES ? req.model : defaultProfile
      ) as DemoProfileName;
      const spec = DEMO_PROFILES[profileKey];

      await abortableSleep(jitteredDelay(spec.bootMs, 0.1), req.signal);
      yield { kind: 'init', model: spec.modelName };

      const inputTokens = estimateTokens(req.prompt);

      if (req.phase === 'ping') {
        await abortableSleep(jitteredDelay(spec.pingMs - spec.bootMs, 0.12), req.signal);
        yield { kind: 'text', text: 'PONG' };
        yield { kind: 'usage', model: spec.modelName, inputTokens, outputTokens: 1 };
        return;
      }

      if (req.phase === 'upload') {
        const prefillMs = Math.max(120, Math.round((inputTokens / spec.prefillTps) * 1000));
        await abortableSleep(jitteredDelay(prefillMs, 0.08), req.signal);
        const match = req.prompt.match(/Entry #(\d+):[^\n]*marker=(VERIFY-[A-Z0-9]+)/);
        const expected = match?.[2] ?? 'VERIFY-000000';
        yield { kind: 'text', text: expected };
        yield {
          kind: 'usage',
          model: spec.modelName,
          inputTokens,
          outputTokens: estimateTokens(expected),
          promptEvalDurationMs: prefillMs,
        };
        return;
      }

      if (req.phase === 'tool_loop') {
        await abortableSleep(jitteredDelay(spec.pingMs * 0.6, 0.1), req.signal);
        yield { kind: 'tool_call', toolName: 'Read' };
        let content = 'PROBE-DEMO';
        if (req.cwd) {
          try {
            content = (await fs.readFile(path.join(req.cwd, 'probe.txt'), 'utf8')).trim();
          } catch {
            // Keep fallback
          }
        }
        await abortableSleep(jitteredDelay(spec.toolLoopOverheadMs, 0.1), req.signal);
        yield { kind: 'tool_result', toolName: 'Read', text: content };
        yield { kind: 'text', text: content };
        yield {
          kind: 'usage',
          model: spec.modelName,
          inputTokens: inputTokens + 32,
          outputTokens: estimateTokens(content),
        };
        return;
      }

      // Download phase: steady token streaming
      await abortableSleep(jitteredDelay(spec.pingMs - spec.bootMs, 0.12), req.signal);

      let totalOutput = 0;

      if (spec.hasThinking) {
        const thoughtWords =
          'Planning concise numbered explanation covering framing, switching, optical modulation, routing, and congestion control.'.split(
            ' '
          );
        for (const word of thoughtWords) {
          const piece = `${word} `;
          const tok = estimateTokens(piece);
          totalOutput += tok;
          yield { kind: 'thinking', text: piece };
          await abortableSleep(jitteredDelay((tok / spec.decodeTps) * 1000, 0.25), req.signal);
        }
      }

      const fullText = DEMO_SENTENCES.join(' ');
      const words = fullText.split(' ');
      // Emit small 1-2 word chunks to mimic real SSE token frames
      for (let i = 0; i < words.length; i += 2) {
        const slice = words.slice(i, i + 2).join(' ') + (i + 2 < words.length ? ' ' : '');
        const tok = estimateTokens(slice);
        totalOutput += tok;
        yield { kind: 'text', text: slice };
        await abortableSleep(jitteredDelay((tok / spec.decodeTps) * 1000, 0.28), req.signal);
      }

      yield {
        kind: 'usage',
        model: spec.modelName,
        inputTokens,
        outputTokens: totalOutput,
      };
    },
  };
}
