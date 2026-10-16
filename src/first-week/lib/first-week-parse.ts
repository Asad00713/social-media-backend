import type { BrandInput } from '../first-week.types';

/** The model's answer (or a person's brand text) is unusable. Never retry-silently; it is a real failure. */
export class LlmOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmOutputError';
  }
}

const FENCE = '`'.repeat(3);
const FENCE_OPEN = new RegExp(`^${FENCE}(?:json)?\\s*`, 'i');
const FENCE_CLOSE = new RegExp(`\\s*${FENCE}$`);

export const BRAND_LIMITS = {
  sells: 120,
  voiceItem: 24,
  voiceMax: 5,
  audience: 200,
} as const;

/** Maximum caption length: it must fit Twitter/X (280) so one draft works on every target. */
export const MAX_DRAFT_CAPTION = 280;
const MAX_IMAGE_QUERY = 80;

function extractJsonObject(raw: string): Record<string, unknown> {
  const text = (raw ?? '')
    .trim()
    .replace(FENCE_OPEN, '')
    .replace(FENCE_CLOSE, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new LlmOutputError('Model output has no JSON object');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new LlmOutputError('Model output is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LlmOutputError('Model output is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

const clip = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max).trim() : '';

/**
 * Normalise a brand to the spec limits: trim, clip, dedupe voice chips
 * case-insensitively, keep at most 5. Throws when a required part is empty.
 */
export function normaliseBrand(input: {
  sells: unknown;
  voice: unknown;
  audience: unknown;
}): BrandInput {
  const sells = clip(input.sells, BRAND_LIMITS.sells);
  const audience = clip(input.audience, BRAND_LIMITS.audience);

  const seen = new Set<string>();
  const voice: string[] = [];
  for (const item of Array.isArray(input.voice) ? input.voice : []) {
    const chip = clip(item, BRAND_LIMITS.voiceItem);
    const key = chip.toLowerCase();
    if (!chip || seen.has(key)) continue;
    seen.add(key);
    voice.push(chip);
    if (voice.length === BRAND_LIMITS.voiceMax) break;
  }

  if (!sells) throw new LlmOutputError('Brand is missing "sells"');
  if (!audience) throw new LlmOutputError('Brand is missing "audience"');
  if (voice.length === 0) throw new LlmOutputError('Brand has no voice chips');
  return { sells, voice, audience };
}

export function parseBrandJson(raw: string): BrandInput {
  const obj = extractJsonObject(raw);
  return normaliseBrand({
    sells: obj.sells,
    voice: obj.voice,
    audience: obj.audience,
  });
}

export function parseDraftJson(raw: string): {
  caption: string;
  imageQuery: string;
} {
  const obj = extractJsonObject(raw);
  const caption = typeof obj.caption === 'string' ? obj.caption.trim() : '';
  if (!caption) throw new LlmOutputError('Draft has no caption');
  if (caption.length > MAX_DRAFT_CAPTION) {
    throw new LlmOutputError(
      `Draft caption is ${caption.length} characters; the limit is ${MAX_DRAFT_CAPTION}`,
    );
  }
  return { caption, imageQuery: clip(obj.imageQuery, MAX_IMAGE_QUERY) };
}
