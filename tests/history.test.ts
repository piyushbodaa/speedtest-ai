import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendHistory,
  clearHistory,
  compareWithHistory,
  getHistoryFilePath,
  loadHistory,
  readHistory,
} from '../src/core/history.js';
import { makeBufferedResult, makeResult } from './helpers/make-result.js';

let home: string;
let savedHome: string | undefined;

beforeEach(async () => {
  savedHome = process.env.SPEEDTEST_AI_HOME;
  home = await mkdtemp(path.join(os.tmpdir(), 'speedtest-history-test-'));
  process.env.SPEEDTEST_AI_HOME = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.SPEEDTEST_AI_HOME;
  else process.env.SPEEDTEST_AI_HOME = savedHome;
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

const V1_ENTRY = {
  id: 'old-1',
  timestamp: '2026-01-01T00:00:00.000Z',
  targetId: 'claude',
  targetName: 'Claude Code',
  model: 'claude-test-model',
  mode: 'quick',
  summary: { downloadDecodeTps: 999, pingMs: 100, grade: 'HYPER' },
};

describe('history file', () => {
  it('starts empty and round-trips results', async () => {
    expect(await loadHistory()).toEqual([]);
    await appendHistory(makeResult({ id: 'a' }));
    await appendHistory(makeResult({ id: 'b' }));
    const loaded = await loadHistory();
    expect(loaded.map((r) => r.id)).toEqual(['a', 'b']);
    expect(loaded[0].schemaVersion).toBe(2);
    expect((await readdir(home)).sort()).toEqual(['history.json']);
  });

  it('moves a corrupt file aside, warns, and keeps working', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await writeFile(getHistoryFilePath(), '{not json', 'utf8');

    const read = await readHistory();
    expect(read.entries).toEqual([]);
    expect(read.corruptBackupPath).toBe(`${getHistoryFilePath()}.corrupt`);
    expect(await readFile(`${getHistoryFilePath()}.corrupt`, 'utf8')).toBe('{not json');
    expect(String(stderr.mock.calls[0][0])).toContain('history file was unreadable');

    await appendHistory(makeResult({ id: 'fresh' }));
    expect((await loadHistory()).map((r) => r.id)).toEqual(['fresh']);
  });

  it('keeps an earlier backup when the file is corrupted a second time', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await writeFile(getHistoryFilePath(), 'first', 'utf8');
    await loadHistory();
    await writeFile(getHistoryFilePath(), '{"not":"an array"}', 'utf8');
    const read = await readHistory();
    expect(read.corruptBackupPath).toMatch(/history\.json\.corrupt-/);
    expect(await readFile(`${getHistoryFilePath()}.corrupt`, 'utf8')).toBe('first');
    expect((await readdir(home)).filter((f) => f.includes('.corrupt')).length).toBe(2);
  });

  it('ignores bad entries instead of failing', async () => {
    const good = makeResult({ id: 'good' });
    await writeFile(
      getHistoryFilePath(),
      JSON.stringify([{ id: 'x' }, null, { timestamp: 5 }, 'text', 42, [], good, { ...good, id: 'no-rank', summary: {} }]),
      'utf8'
    );
    const read = await readHistory();
    expect(read.entries.map((r) => r.id)).toEqual(['good']);
    expect(read.invalidCount).toBe(6);
    expect(read.legacyCount).toBe(1);
  });

  it('keeps old-version entries in the file but never loads them', async () => {
    await writeFile(getHistoryFilePath(), JSON.stringify([V1_ENTRY]), 'utf8');
    const read = await readHistory();
    expect(read.entries).toEqual([]);
    expect(read.legacyCount).toBe(1);

    await appendHistory(makeResult({ id: 'new' }));
    const onDisk = JSON.parse(await readFile(getHistoryFilePath(), 'utf8')) as Array<{ id: string }>;
    expect(onDisk.map((e) => e.id)).toEqual(['old-1', 'new']);
    expect((await loadHistory()).map((r) => r.id)).toEqual(['new']);
  });

  it('caps the file at 200 entries', async () => {
    const many = Array.from({ length: 205 }, (_, i) => makeResult({ id: `r${i}` }));
    await writeFile(getHistoryFilePath(), JSON.stringify(many), 'utf8');
    await appendHistory(makeResult({ id: 'last' }));
    const loaded = await loadHistory();
    expect(loaded).toHaveLength(200);
    expect(loaded.at(-1)?.id).toBe('last');
    expect(loaded[0].id).toBe('r6');
  });

  it('clears history, and clearing twice is fine', async () => {
    await appendHistory(makeResult());
    await clearHistory();
    await clearHistory();
    expect(await loadHistory()).toEqual([]);
  });
});

describe('compareWithHistory', () => {
  const current = makeResult({ id: 'now', summary: { rankTps: 110 } });

  it('averages the rank metric of matching earlier runs', () => {
    const delta = compareWithHistory(current, [
      makeResult({ id: 'h1', summary: { rankTps: 90 } }),
      makeResult({ id: 'h2', summary: { rankTps: 110 } }),
      current,
    ]);
    expect(delta).toEqual({ sampleCount: 2, avgDecodeTps: 100, deltaPct: 10 });
  });

  it('only compares the same target, model, mode, isolation and rank metric', () => {
    const others = [
      makeResult({ id: 'o1', targetId: 'codex' }),
      makeResult({ id: 'o2', model: 'another-model' }),
      makeResult({ id: 'o3', mode: 'standard' }),
      makeResult({ id: 'o4', isolation: 'as-configured' }),
      makeBufferedResult({ id: 'o5', targetId: 'claude', model: 'claude-test-model' }),
      makeResult({ id: 'o6', summary: { rankTps: 0 } }),
    ];
    expect(compareWithHistory(current, others)).toBeUndefined();
  });

  it('compares buffered runs with buffered runs on E2E', () => {
    const now = makeBufferedResult({ id: 'now', summary: { rankTps: 30 } });
    const delta = compareWithHistory(now, [makeBufferedResult({ id: 'before', summary: { rankTps: 40 } })]);
    expect(delta).toEqual({ sampleCount: 1, avgDecodeTps: 40, deltaPct: -25 });
  });

  it('ignores old-version and malformed entries', () => {
    const history = [V1_ENTRY, null, { id: 'junk' }, { ...makeResult({ id: 'v1ish' }), schemaVersion: 1 }] as never[];
    expect(compareWithHistory(current, history)).toBeUndefined();
  });
});
