import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RESULT_SCHEMA_VERSION, type HistoricalDelta, type SpeedtestResult } from '../types.js';

const MAX_HISTORY_ENTRIES = 200;

export function getHistoryDir(): string {
  return process.env.SPEEDTEST_AI_HOME || path.join(os.homedir(), '.local', 'share', 'speedtest-ai');
}

export function getHistoryFilePath(): string {
  return path.join(getHistoryDir(), 'history.json');
}

export interface HistoryReadResult {
  /** Entries of the current schema version that passed the shape check, oldest first. */
  entries: SpeedtestResult[];
  /** Well-formed entries written by an older version; kept in the file, never used for deltas. */
  legacyCount: number;
  /** Array items that are not results at all; dropped on the next write. */
  invalidCount: number;
  /** Where an unparseable history file was moved to, when that happened during this read. */
  corruptBackupPath?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Anything that could plausibly be a saved result of any version. */
function isStoredEntry(value: unknown): value is Record<string, unknown> {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.timestamp === 'string' &&
    typeof value.targetId === 'string' &&
    isObject(value.summary)
  );
}

export function isCurrentHistoryEntry(value: unknown): value is SpeedtestResult {
  if (!isStoredEntry(value)) return false;
  if (value.schemaVersion !== RESULT_SCHEMA_VERSION) return false;
  const summary = value.summary as Record<string, unknown>;
  return (
    typeof value.model === 'string' &&
    typeof value.targetName === 'string' &&
    typeof value.mode === 'string' &&
    typeof summary.rankTps === 'number' &&
    Number.isFinite(summary.rankTps) &&
    (summary.rankMetric === 'decode' || summary.rankMetric === 'e2e') &&
    typeof summary.grade === 'string'
  );
}

async function moveCorruptFile(file: string): Promise<string | undefined> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const target of [`${file}.corrupt`, `${file}.corrupt-${stamp}`]) {
    try {
      await fs.access(target);
    } catch {
      try {
        await fs.rename(file, target);
        return target;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

async function readStored(): Promise<{ stored: Record<string, unknown>[]; invalidCount: number; corruptBackupPath?: string }> {
  const file = getHistoryFilePath();
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return { stored: [], invalidCount: 0 };
  }
  if (raw.trim() === '') return { stored: [], invalidCount: 0 };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) {
    // Set the damaged file aside instead of overwriting up to 200 earlier runs with the next save.
    const corruptBackupPath = await moveCorruptFile(file);
    if (corruptBackupPath) {
      process.stderr.write(
        `speedtest-ai: history file was unreadable and has been moved to ${corruptBackupPath}; starting a new one.\n`
      );
    }
    return { stored: [], invalidCount: 0, corruptBackupPath };
  }

  const stored = parsed.filter(isStoredEntry);
  return { stored, invalidCount: parsed.length - stored.length };
}

export async function readHistory(): Promise<HistoryReadResult> {
  const { stored, invalidCount, corruptBackupPath } = await readStored();
  const entries = (stored as unknown[]).filter(isCurrentHistoryEntry);
  return {
    entries,
    legacyCount: stored.length - entries.length,
    invalidCount,
    corruptBackupPath,
  };
}

/** Saved results of the current schema version, oldest first. Never throws. */
export async function loadHistory(): Promise<SpeedtestResult[]> {
  return (await readHistory()).entries;
}

export async function appendHistory(result: SpeedtestResult): Promise<void> {
  const dir = getHistoryDir();
  await fs.mkdir(dir, { recursive: true });
  const { stored } = await readStored();
  stored.push(result as unknown as Record<string, unknown>);
  const trimmed = stored.slice(-MAX_HISTORY_ENTRIES);

  // Write-then-rename so an interrupted save never leaves a half-written history file.
  const file = getHistoryFilePath();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(trimmed, null, 2), 'utf8');
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function clearHistory(): Promise<void> {
  try {
    await fs.unlink(getHistoryFilePath());
  } catch {
    // Already absent.
  }
}

/**
 * Compares a result with earlier runs of the same target, model, mode and isolation that were
 * ranked on the same metric. Entries of an older schema version are never compared.
 * `avgDecodeTps` holds the average of the rank metric (decode TPS, or E2E TPS for buffered targets).
 */
export function compareWithHistory(
  current: SpeedtestResult,
  history: SpeedtestResult[]
): HistoricalDelta | undefined {
  const matching = history.filter(
    (item) =>
      isCurrentHistoryEntry(item) &&
      item.id !== current.id &&
      item.targetId === current.targetId &&
      item.model === current.model &&
      item.mode === current.mode &&
      item.isolation === current.isolation &&
      item.summary.rankMetric === current.summary.rankMetric &&
      item.summary.rankTps > 0
  );
  if (matching.length === 0) return undefined;

  const sum = matching.reduce((acc, item) => acc + item.summary.rankTps, 0);
  const avgDecodeTps = Math.round((sum / matching.length) * 10) / 10;
  if (avgDecodeTps <= 0) return undefined;

  const deltaPct = Math.round(((current.summary.rankTps - avgDecodeTps) / avgDecodeTps) * 1000) / 10;
  return { sampleCount: matching.length, avgDecodeTps, deltaPct };
}
