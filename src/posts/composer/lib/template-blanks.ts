import { BadRequestException } from '@nestjs/common';
import { threadToPublish } from '../../publishers/post-format';

/**
 * A template's `{{blank}}`, left unfilled, must never be published.
 *
 * The pattern is the composer's own (socialmedia-frontend
 * `src/features/composer-v2/lib/template-blanks.ts`): DOUBLE braces around a
 * name of letters, digits, underscores and hyphens, spaces allowed inside the
 * braces. Single braces are something else — `{a|b}` is a set of wordings —
 * and a name with any other character is prose, not a blank. The two must
 * change together, or the composer and the server disagree about what is
 * finished.
 *
 * The composer already blocks Publish while a blank is open; this is the
 * server's half, so a stale tab, an older client or a direct API call cannot
 * post "Meet our {{product_name}}".
 */
const BLANK = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/;

/** One place a blank is still open. */
export interface OpenBlank {
  /** The platform whose post carries it. */
  platform: string;
  /** `caption`, or `thread post N` (1-based). */
  where: string;
  /** The blank's name, without braces. */
  name: string;
}

/** What the check reads: the draft's base, its per-platform fields, and where it goes. */
export interface BlankCheckInput {
  base: { text?: string | null } | undefined;
  perPlatform: Record<string, unknown> | undefined;
  /** The platforms being published or scheduled now. */
  platforms: readonly string[];
}

interface StoredOverride {
  overrides?: { text?: unknown };
  platformSpecific?: Record<string, any>;
}

function blankIn(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  return BLANK.exec(text)?.[1];
}

/**
 * Every open blank in what would actually be published: each platform's
 * caption (its own override, else the shared one) and, when it publishes as
 * a thread, each thread post's text. Fields a platform will not publish — a
 * stale thread on a Post, another platform's caption — are not read, so a
 * leftover there never blocks a post.
 */
export function findOpenBlanks(input: BlankCheckInput): OpenBlank[] {
  const found: OpenBlank[] = [];
  for (const platform of new Set(input.platforms)) {
    const own = input.perPlatform?.[platform] as StoredOverride | undefined;
    const caption =
      typeof own?.overrides?.text === 'string'
        ? own.overrides.text
        : input.base?.text;
    const inCaption = blankIn(caption);
    if (inCaption) found.push({ platform, where: 'caption', name: inCaption });

    const thread = threadToPublish<{ text?: unknown }>(own?.platformSpecific);
    thread?.forEach((post, i) => {
      const name = blankIn(post?.text);
      if (name) found.push({ platform, where: `thread post ${i + 1}`, name });
    });
  }
  return found;
}

/** Refuses a publish or schedule that would post an unfilled blank. */
export function assertNoOpenBlanks(input: BlankCheckInput): void {
  const open = findOpenBlanks(input);
  if (open.length === 0) return;
  const first = open[0];
  throw new BadRequestException(
    `Fill in the template blank {{${first.name}}} (${first.platform} ${first.where}) before publishing` +
      (open.length > 1 ? ` — ${open.length} blanks are still open` : ''),
  );
}
