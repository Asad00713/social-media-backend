import type { FacebookPostOptions } from '../../channels/services/facebook.service';

/**
 * The composer's "More settings", Location and Collaborator for Facebook, read
 * from the draft's `platformSpecific` (which reaches the publisher as
 * `metadata` verbatim, so these are the draft's own key names).
 *
 * Every value is sent only when it is set and valid: an explicit empty value
 * is one more key Graph can reject the whole post over.
 */

/**
 * The minimum ages Graph's publishing `targeting.age_min` takes - "Value can
 * be 13, 15, 18, 21, or 25" (Page feed reference). Anything else is not sent.
 */
export const FACEBOOK_MIN_AGES: readonly number[] = [13, 15, 18, 21, 25];

/** A Page id, as Graph prints one: digits only. */
const PAGE_ID = /^\d{1,32}$/;

function pageId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return PAGE_ID.test(id) ? id : undefined;
}

/** The location Page (`place`), shared by feed, photo and Reel. */
export function facebookPlace(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  return pageId(metadata?.place);
}

/** The Page invited to collaborate on a Reel. */
export function facebookCollaborator(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  return pageId(metadata?.collaboratorPageId);
}

/**
 * Backdate, minimum age and location for a feed or photo post.
 *
 * A backdate in the future is NOT sent: "a time in the past to backdate this
 * post to" (reference), and a post scheduled past its own backdate would
 * otherwise be rejected at publish time, long after the user chose it.
 */
export function facebookPostOptions(
  metadata: Record<string, unknown> | undefined,
  now: number = Date.now(),
): FacebookPostOptions {
  const options: FacebookPostOptions = {};

  if (typeof metadata?.backdatedTime === 'string') {
    const ms = Date.parse(metadata.backdatedTime);
    if (Number.isFinite(ms) && ms < now) {
      options.backdatedTime = Math.floor(ms / 1000);
    }
  }

  const minAge = metadata?.minAge;
  if (typeof minAge === 'number' && FACEBOOK_MIN_AGES.includes(minAge)) {
    options.targeting = { age_min: minAge };
  }

  const place = facebookPlace(metadata);
  if (place) options.place = place;

  return options;
}
