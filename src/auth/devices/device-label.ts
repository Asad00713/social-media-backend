import Bowser from 'bowser';

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
