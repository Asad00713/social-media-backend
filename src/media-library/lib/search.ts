/**
 * Builds a contains pattern for `ilike`, escaping the LIKE wildcards so a
 * user typing `50%` or `_` searches for those characters literally. Postgres'
 * default LIKE escape character is the backslash.
 */
export function ilikePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}
