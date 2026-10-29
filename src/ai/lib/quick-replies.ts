import { ServiceUnavailableException } from '@nestjs/common';

export const QUICK_REPLY_COUNT = 3;
export const QUICK_REPLY_MAX_CHARS = 60;

function stripFence(raw: string): string {
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : raw).trim();
}

/** Strict: a JSON array of exactly 3 strings (a code fence is tolerated). */
function candidates(raw: string): string[] {
  const body = stripFence(raw);
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      Array.isArray(parsed) &&
      parsed.length === QUICK_REPLY_COUNT &&
      parsed.every((v) => typeof v === 'string')
    ) {
      return parsed as string[];
    }
  } catch {
    // not JSON
  }
  throw new ServiceUnavailableException('AI returned too few suggestions');
}

/** Cut to the limit at the last word boundary, without a dangling mark. */
function clip(text: string): string {
  if (text.length <= QUICK_REPLY_MAX_CHARS) return text;
  const head = text.slice(0, QUICK_REPLY_MAX_CHARS + 1);
  // If the char after the cut is a space the cut already lands on a word.
  const atWord = /\s/.test(head[QUICK_REPLY_MAX_CHARS]);
  const cut = atWord
    ? head.slice(0, QUICK_REPLY_MAX_CHARS)
    : head.slice(0, head.lastIndexOf(' ', QUICK_REPLY_MAX_CHARS));
  const trimmed = (cut || head.slice(0, QUICK_REPLY_MAX_CHARS))
    .replace(/[\s,;:.\-–—]+$/u, '')
    .trim();
  return trimmed;
}

/**
 * Turns the model output into exactly three short replies. Only a JSON array
 * of exactly 3 non-empty strings is accepted (optionally in a ```json fence);
 * anything else is a 503. Each reply is trimmed and cut to 60 chars.
 */
export function parseQuickReplies(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates(raw)) {
    const reply = clip(c.trim());
    if (!reply || seen.has(reply)) continue;
    seen.add(reply);
    out.push(reply);
    if (out.length === QUICK_REPLY_COUNT) break;
  }
  if (out.length < QUICK_REPLY_COUNT) {
    throw new ServiceUnavailableException('AI returned too few suggestions');
  }
  return out;
}
