import { rgb } from './ansi.js';

type Rgb = readonly [number, number, number];

/**
 * The accent each agent CLI uses in its own terminal UI, so its speedometer looks like the tool
 * being tested. Targets without an entry keep the speed-based colours.
 */
const BRAND_RGB: Record<string, Rgb> = {
  claude: [217, 119, 87],
  codex: [16, 163, 127],
  agy: [66, 133, 244],
  grok: [229, 229, 229],
  muse: [167, 139, 250],
  gemini: [138, 180, 248],
  qwen: [97, 92, 237],
  opencode: [250, 178, 131],
  copilot: [137, 87, 229],
  'cursor-agent': [237, 237, 237],
  amp: [243, 78, 63],
  goose: [255, 165, 0],
};

export function brandRgb(targetId: string | undefined): Rgb | undefined {
  return targetId ? BRAND_RGB[targetId] : undefined;
}

/** Paints text in the target's brand colour, or returns undefined when it has none. */
export function brandPaint(targetId: string | undefined): ((s: string) => string) | undefined {
  const value = brandRgb(targetId);
  return value ? rgb(value[0], value[1], value[2]) : undefined;
}
