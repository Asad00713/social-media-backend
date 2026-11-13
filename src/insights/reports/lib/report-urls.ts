import type { ConfigService } from '@nestjs/config';

/** The app's origin, with no trailing slash: where a report's share page lives. */
export function reportsFrontendUrl(config: ConfigService): string {
  const url = config.get<string>('FRONTEND_URL') ?? 'http://localhost:3001';
  return url.replace(/\/+$/, '');
}

/** `${FRONTEND_URL}/r/${token}`: the public page for a share or render token. */
export function reportShareUrl(frontendUrl: string, token: string): string {
  return `${frontendUrl}/r/${token}`;
}
