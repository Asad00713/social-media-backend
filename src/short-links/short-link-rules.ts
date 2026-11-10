import { randomInt } from 'node:crypto';
import { SHORT_LINK_TARGET_MAX } from '../drizzle/schema/short-links.schema';

/**
 * The pure rules behind short links: what a code looks like, how one is
 * made, where short URLs live and which targets are allowed. Kept apart from
 * the service so each rule is tested on its own.
 */

/** The 62 characters a code is drawn from. */
export const CODE_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Seven base62 characters: 62^7 ≈ 3.5 trillion codes, so a random draw
 * collides about once per 350,000 draws even at ten million links, and the
 * service simply draws again.
 */
export const CODE_LENGTH = 7;

/** Codes the redirect accepts. Wider than CODE_LENGTH so it can change. */
export const CODE_PATTERN = /^[0-9A-Za-z]{4,16}$/;

/** Fresh draws before a create gives up (each a full uniqueness check). */
export const CODE_ATTEMPTS = 5;

/** New links a workspace may create in one rolling hour. */
export const CREATE_LIMIT_PER_HOUR = 200;

/** Most links one list returns. */
export const LIST_LIMIT = 100;

/** Most codes one `?codes=` filter may name. */
export const CODES_FILTER_MAX = 50;

/** The path the public redirect is served on. */
export const REDIRECT_PATH = 'l';

/** A random code from a CSPRNG; `pick` is injectable for tests. */
export function generateCode(
  pick: (max: number) => number = randomInt,
): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[pick(CODE_ALPHABET.length)];
  }
  return out;
}

/** `raw` as an http(s) base without query, hash or trailing slash. */
function asBase(raw: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.search = '';
    url.hash = '';
    return url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** This API's own `/l` base: `API_PUBLIC_URL`, then `APP_URL`. */
function apiRedirectBase(env: NodeJS.ProcessEnv): string | null {
  const origin = (env.API_PUBLIC_URL || env.APP_URL || '').trim();
  return origin
    ? asBase(`${origin.replace(/\/+$/, '')}/${REDIRECT_PATH}`)
    : null;
}

/**
 * Where short URLs live, without a trailing slash: `SHORT_LINK_BASE_URL` when
 * set (a custom short domain, later), else this API's own public origin plus
 * `/l` — the same `API_PUBLIC_URL`, then `APP_URL`, chain every other public
 * callback uses. Null when neither is a usable http(s) URL.
 */
export function shortLinkBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = (env.SHORT_LINK_BASE_URL ?? '').trim();
  return explicit ? asBase(explicit) : apiRedirectBase(env);
}

/**
 * Every base a short URL of ours can sit under: the configured one AND this
 * API's own `/l`, which keeps redirecting when a custom domain is added. A
 * target under any of them would redirect to itself.
 */
export function selfLinkBases(env: NodeJS.ProcessEnv = process.env): string[] {
  const all = [shortLinkBaseUrl(env), apiRedirectBase(env)];
  return [...new Set(all.filter((b): b is string => b !== null))];
}

/** The short URL for a code. */
export function shortUrlFor(baseUrl: string, code: string): string {
  return `${baseUrl}/${code}`;
}

/** Why a target URL was refused, worded for the person who typed it. */
export type TargetUrlProblem =
  | 'empty'
  | 'too_long'
  | 'invalid'
  | 'scheme'
  | 'credentials'
  | 'self';

export const TARGET_URL_MESSAGES: Record<TargetUrlProblem, string> = {
  empty: 'Enter a link to shorten.',
  too_long: `That link is longer than ${SHORT_LINK_TARGET_MAX} characters.`,
  invalid: 'That is not a valid web address.',
  scheme: 'Only http and https links can be shortened.',
  credentials: 'Links that carry a username or password cannot be shortened.',
  self: 'That is already a short link.',
};

export type TargetUrlResult =
  | { ok: true; url: string }
  | { ok: false; problem: TargetUrlProblem };

/**
 * Check and normalise a target URL. Only http(s) — never `javascript:`,
 * `data:` or `file:`, since the redirect sends a browser wherever this says.
 * No embedded credentials (`https://bank.com@evil.test` is a phishing
 * shape). Not one of our own short URLs, which would redirect to itself.
 * Normalised through WHATWG URL, so the stored form is ASCII and the
 * idempotency key does not split `HTTPS://X.com` from `https://x.com/`.
 */
export function checkTargetUrl(
  input: unknown,
  selfBases: readonly string[],
): TargetUrlResult {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return { ok: false, problem: 'empty' };
  if (raw.length > SHORT_LINK_TARGET_MAX) {
    return { ok: false, problem: 'too_long' };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problem: 'invalid' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, problem: 'scheme' };
  }
  if (!url.hostname) return { ok: false, problem: 'invalid' };
  if (url.username || url.password) {
    return { ok: false, problem: 'credentials' };
  }
  if (selfBases.some((base) => isUnderBase(url, base))) {
    return { ok: false, problem: 'self' };
  }
  const href = url.href;
  if (href.length > SHORT_LINK_TARGET_MAX) {
    return { ok: false, problem: 'too_long' };
  }
  return { ok: true, url: href };
}

/** True when `url` is on the short host, under the short path. */
function isUnderBase(url: URL, baseUrl: string): boolean {
  const base = new URL(baseUrl);
  if (url.host.toLowerCase() !== base.host.toLowerCase()) return false;
  const basePath = base.pathname.replace(/\/+$/, '');
  return basePath === '' || url.pathname.startsWith(`${basePath}/`);
}

/**
 * A redirect target is re-checked when it is served: the CHECK in 0061 and
 * the create path both refuse other schemes, but the redirect is the one
 * place a bad row would hurt someone, so it does not trust either.
 */
export function isSafeRedirectTarget(target: string): boolean {
  try {
    const url = new URL(target);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
