import crypto from 'node:crypto';
import type { BenchmarkMode } from '../types.js';
import { estimateTokens } from './tokenizer.js';

export interface PingPayload {
  prompt: string;
  expected: string;
}

export interface DownloadPayload {
  prompt: string;
  sentenceCount: number;
}

export interface UploadPrefillPayload {
  prompt: string;
  expectedCode: string;
  estimatedInputTokens: number;
}

export interface ToolLoopPayload {
  filename: string;
  fileContent: string;
  prompt: string;
  expectedToken: string;
}

export function buildPingPayload(): PingPayload {
  return {
    prompt: 'Reply with ONLY the single word PONG and nothing else.',
    expected: 'PONG',
  };
}

export function buildDownloadPayload(mode: BenchmarkMode): DownloadPayload {
  const sentenceCount = mode === 'full' ? 28 : 18;
  const prompt = [
    `Write a continuous, dense plain-text technical explanation of how packet-switched networks, TCP congestion control, and fiber-optic routing work end-to-end.`,
    `Format your response strictly as numbered plain-text sentences from 1 to ${sentenceCount}, each around 15 words long.`,
    `Do not use tools, do not use markdown code blocks, and begin writing sentence 1 immediately.`,
  ].join(' ');

  return { prompt, sentenceCount };
}

export function buildUploadPrefillPayload(mode: BenchmarkMode): UploadPrefillPayload {
  const entryCount = mode === 'full' ? 140 : 80;
  const needleIndex = Math.floor(entryCount * 0.6);
  const expectedCode = `VERIFY-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  const lines: string[] = [
    'Analyze the following unique synthetic network telemetry log and answer the single question at the end.',
    '',
  ];

  const nodes = ['iad-core-01', 'fra-edge-04', 'nrt-pop-02', 'sfo-gw-09', 'lhr-agg-03'];
  const states = ['SYNC_ACK', 'FLOW_CTRL', 'ROUTE_OK', 'PKT_FWD', 'CONG_AVOID'];

  for (let i = 1; i <= entryCount; i++) {
    const nonce = crypto.randomBytes(4).toString('hex');
    const node = nodes[i % nodes.length];
    const state = states[(i * 3) % states.length];
    const latency = 12 + ((i * 17) % 85);
    const codeTag = i === needleIndex ? expectedCode : `TAG-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    lines.push(
      `Entry #${i}: nonce=${nonce} node=${node} state=${state} rtt_ms=${latency} cwnd=${64 + (i % 32)} seq=${10000 + i * 7} marker=${codeTag}`
    );
  }

  lines.push('');
  lines.push(
    `Question: What is the exact VERIFY-XXXXXX marker code in Entry #${needleIndex}? Reply with ONLY that exact code and nothing else.`
  );

  const prompt = lines.join('\n');
  return {
    prompt,
    expectedCode,
    estimatedInputTokens: estimateTokens(prompt),
  };
}

export function buildToolLoopPayload(): ToolLoopPayload {
  const expectedToken = `PROBE-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  return {
    filename: 'probe.txt',
    fileContent: expectedToken,
    prompt: 'Read the file named probe.txt in the current directory and reply with ONLY its exact text content, nothing else.',
    expectedToken,
  };
}
