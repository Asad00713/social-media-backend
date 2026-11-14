/**
 * Routes whose URL carries a credential, in the path or the query. A request
 * URL is persisted to the logs table for every failed request (4xx included)
 * and read by admins, so a bearer token in it must never reach that table.
 *
 * Each entry keeps the route prefix and replaces the credential.
 */
const TOKEN_IN_PATH: Array<[RegExp, string]> = [
  // Channel connect links: /public/connect-links/<raw token>[/<platform>/start]
  [/(\/public\/connect-links\/)[^/?#\s]+/gi, '$1[redacted]'],
  // ...and the Facebook selection id in their query
  // (/public/connect-links/<token>/facebook/pages?selection=<id>): it is
  // single use, but until used it lists the client's Pages.
  [
    /(\/public\/connect-links\/[^?#\s]*\?(?:[^#\s]*&)?selection=)[^&#\s]+/gi,
    '$1[redacted]',
  ],
];

/** The request URL with every credential segment replaced by `[redacted]`. */
export function redactSensitivePath(url: string): string {
  return TOKEN_IN_PATH.reduce(
    (out, [pattern, replacement]) => out.replace(pattern, replacement),
    url,
  );
}
