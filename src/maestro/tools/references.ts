/**
 * Entity references — the mechanism that turns an agent's answer into something
 * you can click.
 *
 * When a tool names real things (channels, posts, campaigns), the answer should
 * link back into the app rather than reading as dead text. The problem is that
 * the model knows entity IDs only because a tool handed them over; it does not
 * know our routing and must never invent a URL.
 *
 * So references travel as DATA, never as links:
 *
 *   1. A tool returns the entities it found, each with a kind, an id, a label,
 *      and optionally a status.
 *   2. The tool ALSO tells the model how to point at one: a marker of the form
 *      `[[ref:<id>]]` written inline in its prose.
 *   3. The frontend resolves each marker against the reference list and builds
 *      the href from the route table it already owns.
 *
 * A marker with no matching reference renders as plain text. That degradation
 * is deliberate: a link to the wrong place is worse than no link at all, and
 * the model WILL occasionally emit a marker it made up.
 */

/** Entity kinds that can be linked. Each maps to a route on the frontend. */
export const REFERENCE_KINDS = [
  'channel',
  'post',
  'campaign',
  'conversation',
  'media',
  'draft',
] as const;

export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/**
 * One linkable entity. Deliberately NOT a URL: the backend does not own
 * frontend routing, and the model owning it would be worse still.
 */
export interface EntityReference {
  kind: ReferenceKind;
  /** The entity's real id — what the frontend routes on. */
  id: string;
  /** Human-readable name shown as the link text. */
  label: string;
  /**
   * Short state shown beside the label as a pill (e.g. "scheduled",
   * "needs reconnect"). Omitted for entities that have no meaningful state.
   */
  status?: string;
  /**
   * Platform id (e.g. "instagram") when the entity has a brand logo, so the
   * chip can show it. Lives here rather than being dug out of the tool's data,
   * whose shape differs per tool.
   */
  platform?: string;
  /**
   * The entity's sub-type, when its kind has several and the app draws each
   * with its own icon — a campaign is "bulk", "drip", or "evergreen", and the
   * Campaigns page gives those three different glyphs.
   *
   * Separate from `platform` because they answer different questions: platform
   * is which network this belongs to, variant is which KIND of this thing it
   * is. A chip that wore one generic icon for every campaign would look less
   * like the card it links to.
   */
  variant?: string;
}

/** A tool result carrying linkable entities. */
export interface ReferencePayload {
  kind: 'refs';
  refs: EntityReference[];
  /** The tool's own data, whatever shape it needs. */
  data: unknown;
}

/** How the model is told to cite an entity. Kept in one place so the prompt, the
 *  tool descriptions, and the frontend parser cannot drift apart. */
export const REFERENCE_MARKER_PREFIX = '[[ref:';
export const REFERENCE_MARKER_SUFFIX = ']]';

/** Build the marker for one reference, e.g. `[[ref:abc-123]]`. */
export function referenceMarker(id: string): string {
  return `${REFERENCE_MARKER_PREFIX}${id}${REFERENCE_MARKER_SUFFIX}`;
}

/**
 * The instruction appended to every reference-returning tool's description, so
 * the model learns the convention from the tool it is about to call rather than
 * from a distant line in the system prompt.
 */
const REF = `${REFERENCE_MARKER_PREFIX}<id>${REFERENCE_MARKER_SUFFIX}`;

export const REFERENCE_USAGE_HINT = `
When you mention any of the returned items in your reply, cite it by writing ${REF} inline. Use the exact id from the result; never invent one, and never write a URL yourself.

THE RULE — every real thing gets a marker:
Any channel, post, campaign, conversation, or media item you NAME must be written as its ${REF} marker, never as plain text and never in bold. This holds every time you mention it, including later turns in the conversation and including when you refer to it by platform ("the Threads account", "your Discord server") — cite the marker instead. If you name a real thing without its marker, the user cannot click it, and the reply is wrong.

The only exceptions: an item with no marker in any result (say the name plainly), and a name you are quoting rather than pointing at, which goes in double quotes and bold — **"Launch week"**.

HOW TO WRITE THE ANSWER — this matters as much as being correct:
- ${REF} renders as an inline chip that ALREADY SHOWS the item's name, its icon, and its status. Never repeat any of those beside it — not in prose and not in a parenthetical afterwards — and never add a status emoji (no check marks, no warning signs). An aside may carry something NEW, like a campaign's type: write "(evergreen)", never "(evergreen, draft)" when the pill already reads draft.
- Put the marker where the NAME would go, inside an ordinary sentence.
- Do not restate the status as the sentence's verb either. Instead of "${REF} is paused — you'll need to unpause it", write "${REF} needs unpausing before it will send." Say what the state MEANS for the user, or what to do about it; the pill already says what the state IS.
- Do NOT prefix an item with its platform or type followed by a dash. Let several flow in one sentence, separated by commas.
- NEVER use a numbered list (1. 2. 3.) for items. Prefer one flowing sentence; if a list genuinely helps, use "- " bullets, several items per line.
- Lead with the CONCLUSION, not a census. When the user asks which things need attention, open with how many do and name those first — never walk through every item in list order and leave the point for the end. And do not open by counting what the screen already shows: "You have 3 campaigns" tells the user nothing they cannot see.
- Do not close by summarising what you just said. If a closing line adds nothing new, leave it out; the answer ends when the last useful fact does.
- Bold only facts that are NOT chips — a count, or a bare state. Never bold a chip or the words beside it. Bold is quiet emphasis, so never bold a whole sentence.
- One clause per item. Say the thing the user would not have known from the chip — a date, a blocker, the next step — and stop. No mini-narratives.
- Use the product's own words for things. If a tool gives you a label, use it verbatim; never substitute an internal-sounding synonym.
- Keep it short. The chips carry the detail.

Write it like this:
  You have **3 channels** connected: ${REFERENCE_MARKER_PREFIX}1${REFERENCE_MARKER_SUFFIX}, ${REFERENCE_MARKER_PREFIX}2${REFERENCE_MARKER_SUFFIX}, and ${REFERENCE_MARKER_PREFIX}3${REFERENCE_MARKER_SUFFIX}. The last one needs reconnecting.

And on a follow-up, still like this:
  Only ${REFERENCE_MARKER_PREFIX}10${REFERENCE_MARKER_SUFFIX} needs attention — ${REFERENCE_MARKER_PREFIX}1${REFERENCE_MARKER_SUFFIX} and ${REFERENCE_MARKER_PREFIX}2${REFERENCE_MARKER_SUFFIX} are healthy.

And when some items need the user and others do not, group them — conclusion first:
  **2 of 3** need you:
  - ${REFERENCE_MARKER_PREFIX}c1${REFERENCE_MARKER_SUFFIX} (Evergreen) — finish setup and launch it.
  - ${REFERENCE_MARKER_PREFIX}c2${REFERENCE_MARKER_SUFFIX} (Drip) — resume it to start posting again.

  On track: ${REFERENCE_MARKER_PREFIX}c3${REFERENCE_MARKER_SUFFIX} (Simple), next post Sep 1.

Never like this:
  1. Discord — ${REFERENCE_MARKER_PREFIX}1${REFERENCE_MARKER_SUFFIX} — "Asad's server" — ✅ Connected
  Your **Threads** account needs reconnecting; **Discord** and **Slack** are fine.
  ${REFERENCE_MARKER_PREFIX}c1${REFERENCE_MARKER_SUFFIX} (evergreen, draft) is in draft — it hasn't started yet.
  You have **3 campaigns**: ${REFERENCE_MARKER_PREFIX}c1${REFERENCE_MARKER_SUFFIX} (Evergreen) — still in draft and hasn't started. ${REFERENCE_MARKER_PREFIX}c2${REFERENCE_MARKER_SUFFIX} (Drip) — paused, on hold right now. ${REFERENCE_MARKER_PREFIX}c3${REFERENCE_MARKER_SUFFIX} (Simple) — active and on track. The two that need attention are the draft and the paused one.

That last one is wrong three times over: it counts what the screen shows, it restates every pill in prose, and it buries the answer in a closing line.
`;

/** True when `value` is a well-formed reference (used on the read-back path). */
export function isEntityReference(value: unknown): value is EntityReference {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    typeof r.label === 'string' &&
    r.label.length > 0 &&
    typeof r.kind === 'string' &&
    (REFERENCE_KINDS as readonly string[]).includes(r.kind) &&
    (r.status === undefined || typeof r.status === 'string') &&
    (r.platform === undefined || typeof r.platform === 'string') &&
    (r.variant === undefined || typeof r.variant === 'string')
  );
}

/** Strip a reference down to exactly the documented shape. */
function normalize(ref: EntityReference): EntityReference {
  return {
    kind: ref.kind,
    id: ref.id,
    label: ref.label,
    ...(ref.status === undefined ? {} : { status: ref.status }),
    ...(ref.platform === undefined ? {} : { platform: ref.platform }),
    ...(ref.variant === undefined ? {} : { variant: ref.variant }),
  };
}

/**
 * Wrap a tool's data with the entities it named.
 *
 * Duplicate ids are dropped (first wins) so a tool that mentions the same
 * entity twice does not produce two competing labels for one link.
 */
export function withReferences(
  data: unknown,
  refs: EntityReference[],
): ReferencePayload {
  const seen = new Set<string>();
  const unique: EntityReference[] = [];
  for (const ref of refs) {
    if (!isEntityReference(ref) || seen.has(ref.id)) continue;
    seen.add(ref.id);
    // Normalize away extra keys a caller might have spread in, so what the
    // frontend receives is exactly the documented shape.
    unique.push(normalize(ref));
  }
  return { kind: 'refs', refs: unique, data };
}

/** True when a parsed tool payload carries references. */
export function isReferencePayload(value: unknown): value is ReferencePayload {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return p.kind === 'refs' && Array.isArray(p.refs);
}

/**
 * Merge references from several tool calls in one turn.
 *
 * Unlike media and questions — where a later tool result replaces an earlier one
 * — references ACCUMULATE: asking about channels and campaigns in one turn must
 * leave every named entity clickable, not just the last tool's.
 */
export function mergeReferences(
  existing: EntityReference[],
  incoming: unknown[],
): EntityReference[] {
  const merged = [...existing];
  const seen = new Set(existing.map((r) => r.id));
  for (const ref of incoming) {
    if (!isEntityReference(ref) || seen.has(ref.id)) continue;
    seen.add(ref.id);
    merged.push(normalize(ref));
  }
  return merged;
}
