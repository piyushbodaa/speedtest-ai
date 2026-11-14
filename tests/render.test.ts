import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderResultCard, renderSvgCard, renderTextCard, resultTags } from '../src/core/card.js';
import {
  displayWidth,
  sanitizeInline,
  stripAnsi,
  tailToWidth,
  truncateAnsi,
  wrapText,
} from '../src/tui/ansi.js';
import {
  renderCompactResult,
  renderCompareTable,
  renderDetectTable,
  renderHistoryTable,
} from '../src/tui/dashboard.js';
import {
  FRAME_HEIGHT,
  type LiveDashboardState,
  renderBigNumber,
  renderDashboardFrame,
  renderSpeedometer,
} from '../src/tui/gauge.js';
import { buildPickerItems, renderPickerLines } from '../src/tui/prompt.js';
import { makeBufferedResult, makePhase, makeResult, makeTarget } from './helpers/make-result.js';

// One less than the terminal width, as the CLI does, for terminals of 39, 60, 80 and 120 columns.
const WIDTHS = [38, 59, 79, 119];
const LONG_MODEL = 'muse-spark-1.3-contributor-preview-build-with-a-very-long-suffix-2026-11-14';
const WIDE_TEXT = '日本語のテキスト 🚀 emoji 한국어 텍스트 and plain words to fill the remaining preview space';

let savedForceColor: string | undefined;
let savedNoColor: string | undefined;

beforeAll(() => {
  savedForceColor = process.env.FORCE_COLOR;
  savedNoColor = process.env.NO_COLOR;
  process.env.FORCE_COLOR = '1';
  delete process.env.NO_COLOR;
});

afterAll(() => {
  if (savedForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = savedForceColor;
  if (savedNoColor !== undefined) process.env.NO_COLOR = savedNoColor;
});

function expectFits(text: string, width: number): void {
  for (const line of text.split('\n')) {
    expect(displayWidth(line), `line wider than ${width}: ${JSON.stringify(stripAnsi(line))}`).toBeLessThanOrEqual(width);
  }
}

function expectClosedBox(text: string, width: number): void {
  const lines = text.split('\n').map(stripAnsi);
  const boxWidth = displayWidth(lines[0]);
  expect(boxWidth).toBeLessThanOrEqual(width);
  for (const line of lines) {
    expect(displayWidth(line), `ragged box line: ${JSON.stringify(line)}`).toBe(boxWidth);
    expect('│┐┤┘').toContain(line.at(-1));
  }
}

describe('ansi helpers', () => {
  it('counts wide characters as two cells and ignores escape sequences', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('日本')).toBe(4);
    expect(displayWidth('🚀')).toBe(2);
    expect(displayWidth('é')).toBe(1);
    expect(displayWidth('\x1b[1m\x1b[96mhi\x1b[0m')).toBe(2);
    expect(displayWidth('\x1b[?25lhi\x1b[?25h')).toBe(2);
  });

  it('truncates by display width and keeps the colour of the kept part', () => {
    const coloured = `\x1b[31m${'x'.repeat(20)}\x1b[0m`;
    const cut = truncateAnsi(coloured, 10);
    expect(displayWidth(cut)).toBe(10);
    expect(cut.startsWith('\x1b[31m')).toBe(true);
    expect(cut.endsWith('\x1b[0m')).toBe(true);
    expect(stripAnsi(cut)).toBe(`${'x'.repeat(9)}…`);
  });

  it('never splits a wide character across the limit', () => {
    const cut = truncateAnsi('日本語のテキスト', 6);
    expect(displayWidth(cut)).toBeLessThanOrEqual(6);
    expect(stripAnsi(cut)).toBe('日本…');
    expect(truncateAnsi('short', 10)).toBe('short');
    expect(truncateAnsi('anything', 0)).toBe('');
  });

  it('keeps the tail of a preview by display width', () => {
    expect(tailToWidth('abcdef', 3)).toBe('def');
    expect(displayWidth(tailToWidth(WIDE_TEXT, 21))).toBeLessThanOrEqual(21);
  });

  it('wraps text to the width, splitting words that are too long', () => {
    const lines = wrapText(`one two three ${'x'.repeat(40)} four`, 12);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(12);
    expect(lines.join('').replaceAll(' ', '')).toContain('x'.repeat(40));
  });

  it('removes escape sequences and control characters from untrusted text', () => {
    expect(sanitizeInline('a\x1b[2Jb\r\nc\x07d\tend')).toBe('ab c d end');
    expect(sanitizeInline('bad\uD83D')).toBe('bad');
  });
});

describe('result card', () => {
  const variants = {
    streaming: makeResult(),
    longModel: makeResult({ model: LONG_MODEL, targetName: 'Muse Code CLI with a long product name' }),
    buffered: makeBufferedResult({ notes: ['codex app-server did not start; used codex exec (buffered)'] }),
    experimental: makeResult({ tier: 'experimental', isolation: 'as-configured', summary: { shortOutput: true } }),
    wideChars: makeResult({ model: '模型名称が長い場合のテスト-🚀-한국어', notes: [WIDE_TEXT] }),
    standard: makeResult({
      mode: 'standard',
      phases: {
        ping: makePhase({ phase: 'ping' }),
        download: makePhase(),
        upload: makePhase({ phase: 'upload', prefillTps: null, uploadOverheadMs: 310 }),
      },
      skipped: [{ phase: 'tool_loop', reason: 'no tool call observed: the answer did not come from reading the file' }],
      summary: {
        uploadTtftMs: 650,
        uploadOverheadMs: 310,
        uploadPrefillTps: null,
        uploadPrefillReason: 'answer verified but the overhead was under 100 ms',
        toolLoopVerified: false,
        reportedOutputTokens: 800,
        reportedInputTokens: 1200,
        cachedInputTokens: 900,
        reportedReasoningTokens: 120,
        costUsd: 0.0123,
      },
    }),
  };

  for (const width of WIDTHS) {
    for (const [name, result] of Object.entries(variants)) {
      it(`${name} fits ${width} columns with a closed box`, () => {
        const delta = { sampleCount: 3, avgDecodeTps: 70, deltaPct: 11.6 };
        expectClosedBox(renderResultCard(result, delta, { width, color: true }), width);
        expectClosedBox(renderTextCard(result, delta, width), width);
      });
    }
  }

  it('keeps the closing parenthesis of a long model name and stays coloured', () => {
    const card = renderResultCard(variants.longModel, undefined, { width: 66, color: true });
    const titleLine = card.split('\n')[1];
    expect(stripAnsi(titleLine)).toMatch(/\(muse-spark.*…\)\s+│$/);
    expect(titleLine).toContain('\x1b[');
  });

  it('shows a buffered target without a TTFT and ranked on E2E', () => {
    const card = renderTextCard(variants.buffered, undefined, 66);
    expect(card).toContain('n/a (buffered)');
    expect(card).toContain('34.5 tok/s (E2E)');
    expect(card).toContain('STEADY (E2E)');
    expect(card).toContain('buffered');
    expect(card).not.toContain('\x1b[');
  });

  it('shows failed phases, vendor counts and the single-sample note', () => {
    const card = renderTextCard(variants.standard, undefined, 66)
      .split('\n')
      .map((l) => l.slice(1, -1).trim())
      .join(' ');
    expect(card).toMatch(/UPLOAD\s+\+310 ms vs ping/);
    expect(card).toMatch(/Agent loop\s+failed/);
    expect(card).toContain('Agent loop failed: no tool call observed');
    expect(card).toContain('800 out · 1200 in (900 cached) · 120 reasoning');
    expect(card).toContain('Single sample');
    expect(card).toContain('normalized tokens');
  });

  it('reports the range for repeated runs', () => {
    const repeated = makeResult({
      runs: 3,
      aggregate: {
        requested: 3,
        completed: 3,
        decodeTpsMin: 70.1,
        decodeTpsMax: 82.3,
        rankTpsMin: 70.1,
        rankTpsMax: 82.3,
        spreadPct: 15.6,
        samples: [],
        failed: [],
      },
    });
    const card = renderTextCard(repeated, undefined, 66);
    expect(card).toContain('Median of 3 runs');
    expect(card).toContain('70.1–82.3 tok/s');
    expect(card).not.toContain('Single sample');
    expect(resultTags(repeated)).toContain('3 runs ±8%');
  });

  it('tags lean, as-configured, experimental, short and buffered results', () => {
    expect(resultTags(makeResult())).toEqual(['lean']);
    expect(resultTags(variants.experimental)).toEqual(['experimental', 'short', 'as-configured']);
    expect(resultTags(variants.buffered)).toEqual(['buffered', 'lean']);
  });
});

describe('SVG card', () => {
  it('escapes and truncates the title so it cannot run under the grade pill', () => {
    const svg = renderSvgCard(
      makeResult({ targetName: `Evil <script> & "quotes" ${'x'.repeat(90)}`, model: `${LONG_MODEL}${LONG_MODEL}` })
    );
    expect(svg).toContain('&lt;script&gt; &amp; &quot;quotes&quot;');
    expect(svg).not.toContain('<script>');
    const title = svg.match(/font-size="22"[^>]*>([^<]*)</)?.[1] ?? '';
    expect([...title.replace(/&[a-z]+;/g, '_')].length).toBeLessThanOrEqual(44);
    expect(svg).toContain('TOKENS / SEC (DECODE)');
  });

  it('labels a buffered result as end-to-end with no TTFT', () => {
    const svg = renderSvgCard(makeBufferedResult());
    expect(svg).toContain('END-TO-END, BUFFERED');
    expect(svg).toContain('>n/a<');
    expect(svg).toContain('STEADY (E2E)');
  });
});

describe('live gauge frame', () => {
  const baseState = (): LiveDashboardState => ({
    targetName: 'Claude Code',
    model: 'claude-test-model',
    mode: 'standard',
    phases: ['ping', 'download', 'upload', 'tool_loop'],
    currentPhase: 'download',
    phaseIndex: 2,
    phaseTotal: 4,
    phaseLabel: 'Sustained output (Download)',
    tpsHistory: Array.from({ length: 60 }, (_, i) => 40 + i * 2),
    completedPhases: { ping: makePhase({ phase: 'ping' }) },
    skippedPhases: {},
    frameCounter: 3,
    tick: {
      phase: 'download',
      stage: 'streaming',
      elapsedMs: 4321,
      currentTps: 168.4,
      averageTps: 150.2,
      peakTps: 175,
      tokensGenerated: 4321,
      thinkingTokens: 0,
      previewText: 'the receiver confirms delivery and the sender can release its buffered copy',
    },
  });

  const states: Record<string, LiveDashboardState> = {
    streaming: baseState(),
    longNames: { ...baseState(), model: LONG_MODEL, targetName: 'A very long harness product name indeed' },
    widePreview: { ...baseState(), tick: { ...baseState().tick!, previewText: WIDE_TEXT } },
    escapeInPreview: { ...baseState(), tick: { ...baseState().tick!, previewText: 'a\x1b[2J\x1b[Hb\r\nc' } },
    repeat: { ...baseState(), repeat: { run: 2, of: 5 } },
    booting: { ...baseState(), tick: { ...baseState().tick!, stage: 'booting', previewText: '', currentTps: 0, peakTps: 0 } },
    noTick: { ...baseState(), tick: undefined, tpsHistory: [] },
    buffered: {
      ...baseState(),
      completedPhases: {
        download: makePhase({ isBuffered: true, streaming: false, decodeTps: null, ttftMs: null, e2eTps: 34.5 }),
      },
      skippedPhases: { upload: 'answer not verified' },
    },
  };

  for (const width of [39, 45, 59, 68, 79, 119]) {
    for (const [name, state] of Object.entries(states)) {
      it(`${name} is ${FRAME_HEIGHT} lines that fit width ${width}`, () => {
        const frame = renderDashboardFrame(state, width);
        const lines = frame.split('\n');
        expect(lines).toHaveLength(FRAME_HEIGHT);
        for (const line of lines) {
          expect(displayWidth(stripAnsi(line)), `too wide: ${JSON.stringify(stripAnsi(line))}`).toBeLessThanOrEqual(
            Math.min(width, 68)
          );
        }
        expect(frame).not.toContain('\x1b[2J');
      });
    }
  }

  it('fills the dial in proportion to the speed and shows the reading in large digits', () => {
    const filled = (tps: number) => {
      const lines = renderSpeedometer(tps);
      expect(lines).toHaveLength(9);
      for (const line of lines) expect(displayWidth(stripAnsi(line))).toBe(36);
      // Coloured arc cells are everything painted in a non-gray colour.
      return lines.join('').split('\x1b[90m').length;
    };
    expect(filled(0)).toBeGreaterThan(filled(100));
    expect(filled(100)).toBeGreaterThan(filled(200));
    expect(renderBigNumber('42.5')).toEqual(['█ █ ▀▀█   █▀▀', '▀▀█ █▀▀   ▀▀█', '  ▀ ▀▀▀ ▀ ▀▀▀']);
  });

  it('shows ping, peak and tokens under the dial, and the steps in standard mode', () => {
    const frame = stripAnsi(renderDashboardFrame(states.streaming, 68));
    expect(frame).toContain('Peak 175');
    expect(frame).toContain('Tokens 4321');
    expect(frame).toContain('tokens / sec');
    expect(frame).toContain('✓ Ping');
    expect(frame).toContain('● Speed');
    expect(frame).toContain('○ Tool use');
  });

  it('shows the buffered and failed states in words', () => {
    const frame = stripAnsi(renderDashboardFrame(states.buffered, 68));
    expect(frame).toContain('n/a (buffered)');
    expect(frame).toContain('✗ Large prompt');
  });
});

describe('leaderboard', () => {
  const results = [
    makeBufferedResult(),
    makeResult({ id: 'a', summary: { rankTps: 20.5, downloadDecodeTps: 20.5, grade: 'STEADY' }, targetId: 'agy', model: 'slow-model' }),
    makeResult({ id: 'b', targetId: 'muse', model: LONG_MODEL, tier: 'experimental', summary: { shortOutput: true, rankTps: 125, grade: 'TURBO' } }),
    makeResult({ id: 'c', isolation: 'as-configured' }),
  ];
  const failures = [
    {
      targetId: 'grok',
      targetName: 'Grok CLI',
      error: `Grok CLI: download phase timed out after 120s ${'and a long explanation '.repeat(12)}`,
      kind: 'timeout' as const,
    },
    { targetId: 'gemini', targetName: 'Gemini CLI', error: 'not logged in', kind: 'failed' as const, failureKind: 'auth' as const },
  ];

  for (const width of WIDTHS) {
    it(`fits ${width} columns`, () => {
      expectFits(renderCompareTable(results, { width, failures, notRun: ['claude'], interrupted: true }), width);
      expectFits(renderCompareTable([], { width, failures }), width);
      for (const r of results) expectFits(renderCompactResult(r, width), width);
    });
  }

  it('ranks every streaming target before any buffered one, whatever the numbers', () => {
    const fastBuffered = makeBufferedResult({ summary: { rankTps: 500, downloadE2eTps: 500, grade: 'HYPER' } });
    const table = stripAnsi(renderCompareTable([fastBuffered, ...results.slice(1)], { width: 119 }));
    const order = table
      .split('\n')
      .filter((l) => /^#\d/.test(l))
      .map((l) => l.split(/\s+/)[1].split(':')[0]);
    expect(order).toEqual(['muse', 'claude', 'agy', 'codex']);
  });

  it('shows normalized tok/s, TTFT and every caveat tag', () => {
    const table = stripAnsi(renderCompareTable(results, { width: 119, failures }));
    expect(table).toContain('TOK/S');
    expect(table).toContain('TTFT');
    expect(table).toMatch(/codex:gpt-test\s+34\.5 tok\/s\s+n\/a\s/);
    expect(table).toContain('STEADY (E2E)');
    for (const tag of ['buffered', 'experimental', 'short', 'lean', 'as-configured']) expect(table).toContain(tag);
    expect(table).toContain('normalized tokens');
    expect(table).toContain('Single sample');
    expect(table).toContain('Failed / skipped:');
    expect(table).toContain('grok (Grok CLI)');
    expect(table).toContain('[auth] not logged in');
  });

  it('puts tags on a continuation line when they do not fit at 80 columns', () => {
    const table = stripAnsi(renderCompareTable(results, { width: 79 }));
    expect(table).toContain('↳ experimental · short · lean');
    expect(table).toMatch(/muse:muse-spark.*…/);
  });

  it('says so when nothing completed', () => {
    const table = stripAnsi(renderCompareTable([], { width: 79, failures }));
    expect(table).toContain('No target completed a benchmark:');
    expect(table).not.toContain('leaderboard');
  });
});

describe('detect table, history table and picker', () => {
  const targets = [
    makeTarget(),
    makeTarget({ id: 'codex', name: 'OpenAI Codex CLI', authState: 'logged_out', reason: 'not logged in (run: codex login)' }),
    makeTarget({ id: 'cursor-agent', name: 'Cursor Agent CLI', tier: 'experimental', runnable: false, reason: 'installed, not supported yet: --print flag missing' }),
    makeTarget({ id: 'gemini', name: 'Gemini CLI', tier: 'experimental', reason: `0.9.0 (experimental adapter) ${'x'.repeat(80)}` }),
    makeTarget({ id: 'qwen', name: 'Qwen Code', available: false, runnable: false, tier: 'experimental', reason: 'not installed' }),
    makeTarget({ id: 'ollama', name: 'Ollama (Local)', category: 'local', available: false, runnable: false, reason: 'not listening' }),
    makeTarget({ id: 'openai', name: 'OpenAI API', category: 'provider', available: false, runnable: false, reason: 'missing OPENAI_API_KEY' }),
    makeTarget({ id: 'demo', name: 'Demo Simulator', category: 'demo', reason: 'simulated data, no model is called' }),
  ];

  for (const width of WIDTHS) {
    it(`detect table fits ${width} columns`, () => {
      expectFits(renderDetectTable(targets, width), width);
    });

    it(`history table fits ${width} columns`, () => {
      const history = [makeResult(), makeBufferedResult(), makeResult({ model: LONG_MODEL, mode: 'standard' })];
      expectFits(renderHistoryTable(history, 15, { width, legacyCount: 2 }), width);
      expectFits(renderHistoryTable([], 15, { width, legacyCount: 1 }), width);
    });
  }

  it('separates ready, logged-out, unsupported and missing targets', () => {
    const table = stripAnsi(renderDetectTable(targets, 119));
    expect(table).toMatch(/READY\s+claude/);
    expect(table).toMatch(/LOGGED OUT\s+codex/);
    expect(table).toMatch(/UNSUPPORTED\s+cursor-agent/);
    expect(table).toMatch(/READY\s+gemini\s+Gemini CLI\s+experimental/);
    expect(table).toContain('Agent CLIs not found (1): qwen');
    expect(table).toContain('Local runtimes not running (1): ollama');
    expect(table).toContain('API keys not set (1): openai');
  });

  it('history table shows mode and marks hidden old entries', () => {
    const table = stripAnsi(renderHistoryTable([makeResult(), makeBufferedResult()], 15, { width: 119, legacyCount: 2 }));
    expect(table).toContain('MODE');
    expect(table).toContain('quick');
    expect(table).toContain('STEADY (E2E)');
    expect(table).toContain('2 older-format entries are not shown.');
  });

  const items = buildPickerItems(targets, [targets[0], targets[3]]);

  it('picker offers ALL first and cannot select unusable targets', () => {
    expect(items[0]).toMatchObject({ id: 'all', selectable: true });
    expect(items[0].detail).toContain('real model tokens');
    expect(items.find((i) => i.id === 'codex')?.selectable).toBe(false);
    expect(items.find((i) => i.id === 'cursor-agent')?.selectable).toBe(false);
    expect(items.find((i) => i.id === 'qwen')).toBeUndefined();
  });

  for (const size of [
    { columns: 80, rows: 24 },
    { columns: 60, rows: 20 },
    { columns: 39, rows: 24 },
    { columns: 120, rows: 40 },
    { columns: 100, rows: 8 },
  ]) {
    it(`picker fits ${size.columns}x${size.rows} and keeps the selection visible`, () => {
      for (let selected = 0; selected < items.length; selected++) {
        const lines = renderPickerLines(items, ['qwen', 'ollama'], selected, 'full', size);
        expect(lines.length).toBeLessThan(size.rows);
        for (const line of lines) expect(displayWidth(line)).toBeLessThan(size.columns);
        expect(lines.filter((l) => stripAnsi(l).startsWith('❯')).length).toBe(1);
        expect(stripAnsi(lines.join('\n'))).toContain('FULL');
      }
    });
  }
});
