import Bowser from 'bowser';
import type { DeviceType } from '../../drizzle/schema/user-sessions.schema';

const UNKNOWN_BROWSER = 'Unknown browser';
const LABEL_MAX = 120;

/**
 * 'Chrome on Windows' from a user agent (bowser), 'Unknown browser' when it
 * names no browser. Never the raw string: user agents are personal data.
 * Capped at the 120-char label column.
 */
export function deviceLabel(userAgent: string | null): string {
  if (!userAgent) return UNKNOWN_BROWSER;
  const { browser, os } = Bowser.parse(userAgent);
  if (!browser.name) return UNKNOWN_BROWSER;
  const label = os.name ? `${browser.name} on ${os.name}` : browser.name;
  return label.slice(0, LABEL_MAX);
}

/**
 * desktop | mobile | tablet from the user agent (bowser's platform type), the
 * icon the session list draws. Anything else bowser can name (a TV, a bot)
 * and an empty or missing user agent read as 'unknown'.
 */
export function deviceType(userAgent: string | null | undefined): DeviceType {
  if (!userAgent) return 'unknown';
  const type = Bowser.getParser(userAgent).getPlatformType(true);
  return type === 'desktop' || type === 'mobile' || type === 'tablet'
    ? type
    : 'unknown';
}
