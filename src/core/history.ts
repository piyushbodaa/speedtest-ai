import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HistoricalDelta, SpeedtestResult } from '../types.js';

const MAX_HISTORY_ENTRIES = 200;

export function getHistoryDir(): string {
  return process.env.SPEEDTEST_AI_HOME || path.join(os.homedir(), '.local', 'share', 'speedtest-ai');
}

export function getHistoryFilePath(): string {
  return path.join(getHistoryDir(), 'history.json');
}

export async function loadHistory(): Promise<SpeedtestResult[]> {
  try {
    const raw = await fs.readFile(getHistoryFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SpeedtestResult[]) : [];
  } catch {
    return [];
  }
}

export async function appendHistory(result: SpeedtestResult): Promise<void> {
  const dir = getHistoryDir();
  await fs.mkdir(dir, { recursive: true });
  const existing = await loadHistory();
  existing.push(result);
  const trimmed = existing.slice(-MAX_HISTORY_ENTRIES);
  await fs.writeFile(getHistoryFilePath(), JSON.stringify(trimmed, null, 2), 'utf8');
}

export async function clearHistory(): Promise<void> {
  try {
    await fs.unlink(getHistoryFilePath());
  } catch {
    // Already absent
  }
}

export function compareWithHistory(
  current: SpeedtestResult,
  history: SpeedtestResult[]
): HistoricalDelta | undefined {
  const matching = history.filter(
    (item) =>
      item.id !== current.id &&
      item.targetId === current.targetId &&
      item.model === current.model &&
      item.summary?.downloadDecodeTps > 0
  );

  if (matching.length === 0) return undefined;

  const sum = matching.reduce((acc, item) => acc + item.summary.downloadDecodeTps, 0);
  const avgDecodeTps = Math.round((sum / matching.length) * 10) / 10;
  if (avgDecodeTps <= 0) return undefined;

  const deltaPct =
    Math.round(((current.summary.downloadDecodeTps - avgDecodeTps) / avgDecodeTps) * 1000) / 10;

  return {
    sampleCount: matching.length,
    avgDecodeTps,
    deltaPct,
  };
}
