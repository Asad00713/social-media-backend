/**
 * The routes whose path segment IS the credential: a public report link, a
 * report render token and the unsubscribe and security links of an email. A
 * token in a persisted log row would let anyone who can read the logs act as
 * the person who got the link, so the segment is replaced before a request URL
 * (or a message that quotes it, like Nest's "Cannot GET /...") is stored.
 * Case-insensitive, because Express routes /Email/Unsubscribe/... too.
 */
const TOKEN_PATH =
  /(\/(?:email\/(?:unsubscribe|security)|reports\/(?:public|render|unsubscribe))\/)[\w.~%-]+/gi;

export function redactTokenUrls(text: string): string {
  return text.replace(TOKEN_PATH, '$1[token]');
}
