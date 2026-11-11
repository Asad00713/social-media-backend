/**
 * What a publish left out, as sentences the person can read on the post.
 *
 * A publisher reports a "soft step" that failed after the post went live -
 * the first comment, a Reel cover, captions, a collaborator invite, alt
 * text, media the platform could not carry - as a `<name>Warning` string on
 * `result.metadata`. Both publish paths used to drop that metadata, so the
 * post showed "Published" with the setting silently missing. They now store
 * these sentences on the channel target as `warnings`, and the Planner API
 * returns them (`PlannerPostTargetDto.warnings`).
 *
 * Every `*Warning` key is collected, not only the ones named below, so a
 * publisher that adds a new soft step is surfaced without touching this
 * file; a known key just reads better.
 */

/** What each known soft step was, said as what did not happen. */
const WARNING_LABELS: Readonly<Record<string, string>> = {
  firstCommentWarning: 'First comment was not posted',
  coverWarning: 'Cover was not set',
  thumbnailWarning: 'Thumbnail was not set',
  captionsWarning: 'Captions were not added',
  collaboratorWarning: 'Collaborator was not invited',
  mediaWarning: 'Some media was left out',
  altTextWarning: 'Alt text was not added',
  locationWarning: 'Location was not added',
  playlistWarning: 'Video was not added to the playlist',
};

/**
 * Keys that end in `Warning` but are a SETTING, not a report: Mastodon's
 * and Bluesky's content warning travels in the publisher's input metadata
 * and must never be mistaken for a failure if a publisher echoes it back.
 */
const NOT_A_REPORT = new Set(['contentWarning']);

const WARNING_KEY = /^([a-z][A-Za-z0-9]*)Warning$/;

/** `playlistAddWarning` -> "Playlist add" for a key with no label. */
function labelFor(key: string, stem: string): string {
  const known = WARNING_LABELS[key];
  if (known) return known;
  const words = stem
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The warnings a publish result carries, in the order the publisher wrote
 * them, each as "<what was not done>: <why>". Empty when there are none.
 */
export function publishWarningsOf(
  resultMetadata: Record<string, unknown> | null | undefined,
): string[] {
  if (!resultMetadata || typeof resultMetadata !== 'object') return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(resultMetadata)) {
    if (NOT_A_REPORT.has(key)) continue;
    const match = WARNING_KEY.exec(key);
    if (!match) continue;
    if (typeof value !== 'string') continue;
    const reason = value.trim();
    if (reason === '') continue;
    const sentence = `${labelFor(key, match[1])}: ${reason}`;
    if (!out.includes(sentence)) out.push(sentence);
  }
  return out;
}

/**
 * The `warnings` key to spread onto a stored target: present only when
 * there is something to say, so a clean publish stores no empty list.
 */
export function warningsField(
  resultMetadata: Record<string, unknown> | null | undefined,
): { warnings?: string[] } {
  const warnings = publishWarningsOf(resultMetadata);
  return warnings.length > 0 ? { warnings } : {};
}
