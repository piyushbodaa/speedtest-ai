import { rgb } from './ansi.js';

type Rgb = readonly [number, number, number];

/** Krutrim Mulyankan product naming and the site's one accent colour (dark-theme blue). */
export const PRODUCT_NAME = 'KM AI Speed Test';
export const PRODUCT_TAG = 'KM AI SPEED TEST';
export const PRODUCT_BYLINE = 'by Krutrim Mulyankan · krutrimmulyankan.in/speedtest';
const KM_BLUE: Rgb = [50, 145, 255];

/** Paints text in the Krutrim Mulyankan accent. */
export function kmAccent(s: string): string {
  return rgb(KM_BLUE[0], KM_BLUE[1], KM_BLUE[2])(s);
}

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
