import { BadRequestException } from '@nestjs/common';
import {
  assertPublicHost,
  isPrivateAddressRefusal,
  UnsafeMediaUrlError,
  UnsafeUrlError,
} from './public-fetch';

/** Plain copy for an attachment URL the guard refused. */
export const ATTACHMENT_UNREACHABLE =
  "That attachment link isn't reachable from the internet.";
/** Plain copy for an attachment whose body passed the size cap. */
export const ATTACHMENT_TOO_LARGE = 'That attachment is too large.';

/**
 * The 400 for an attachment download the SSRF guard refused, or null when
 * `err` is anything else (a real network error, a non-2xx answer the caller
 * already reported), which the caller rethrows unchanged.
 *
 * Matches: UnsafeMediaUrlError / UnsafeUrlError from the guard, and undici's
 * `fetch failed` TypeError ONLY when its cause is the connect-time
 * PrivateAddressError.
 */
export function attachmentRefusal(err: unknown): BadRequestException | null {
  if (err instanceof UnsafeMediaUrlError) {
    return new BadRequestException(
      err.reason === 'too_large'
        ? ATTACHMENT_TOO_LARGE
        : ATTACHMENT_UNREACHABLE,
    );
  }
  if (err instanceof UnsafeUrlError || isPrivateAddressRefusal(err)) {
    return new BadRequestException(ATTACHMENT_UNREACHABLE);
  }
  return null;
}

/**
 * Up-front check of a client-supplied attachment URL (http(s), not a private
 * literal, resolves only to public addresses): a 400 before any work starts.
 * The download itself is still pinned at connect time.
 */
export async function assertPublicAttachmentUrl(url: string): Promise<void> {
  try {
    await assertPublicHost(url);
  } catch {
    throw new BadRequestException(ATTACHMENT_UNREACHABLE);
  }
}
