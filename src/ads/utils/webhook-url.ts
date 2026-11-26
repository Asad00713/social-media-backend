import { BadRequestException } from '@nestjs/common';
import { assertPublicHost } from '../../common/net/public-fetch';

/** Shown to the client, and recorded on a refused delivery. */
export const WEBHOOK_URL_UNREACHABLE =
  "That webhook URL isn't reachable from the internet.";

/**
 * A lead webhook URL must name a public http(s) host. Checked before a route
 * is stored and before a test POST, so `localhost`, cloud metadata or a
 * private network never get saved or called. Never echoes the resolved IP.
 */
export async function assertWebhookUrl(url: unknown): Promise<void> {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new BadRequestException('A webhook route needs a URL.');
  }
  try {
    await assertPublicHost(url);
  } catch {
    throw new BadRequestException(WEBHOOK_URL_UNREACHABLE);
  }
}
