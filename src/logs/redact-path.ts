/**
 * Routes whose URL path carries a credential. A request path is persisted to
 * the logs table for every failed request (4xx included) and read by admins,
 * so a bearer token in it must never reach that table.
 *
 * Each entry keeps the route prefix and replaces the token segment.
 */
const TOKEN_IN_PATH: Array<[RegExp, string]> = [
  // Channel connect links: /public/connect-links/<raw token>[/<platform>/start]
  [/(\/public\/connect-links\/)[^/?#]+/gi, '$1[redacted]'],
];

/** The request URL with every credential segment replaced by `[redacted]`. */
export function redactSensitivePath(url: string): string {
  return TOKEN_IN_PATH.reduce(
    (out, [pattern, replacement]) => out.replace(pattern, replacement),
    url,
  );
}
