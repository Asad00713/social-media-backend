/**
 * The one `Linkedin-Version` this codebase sends.
 *
 * ## Why this is a shared constant and not a literal
 *
 * LinkedIn's versioned `/rest` APIs require the header — the latest version is
 * **not** applied by default — and every monthly version is sunset after about
 * a year. So a pinned version is a thing that expires, and a pin that is
 * written down twice expires in one place first.
 *
 * That has now happened twice in this repo:
 *
 * 1. `linkedin.service.ts` once called `/v2/posts` with a hard-coded
 *    `202404` while every other format sent the shared constant. Fixed, with a
 *    spec left behind to stop it recurring.
 * 2. **The analytics adapter sat on `202402` for about two and a half years**
 *    while publishing moved to `202610`. LinkedIn answered every analytics
 *    call with HTTP 426, *"Requested version 20240201 is not active"* — note
 *    LinkedIn expands `202402` to a date in its error text, which is why
 *    grepping the source for `20240201` found nothing.
 *
 * The visible cost of (2) was that **LinkedIn analytics silently returned
 * nothing while LinkedIn publishing worked**, and 12,473 error rows in seven
 * days. One pin, imported by both, is what stops a third occurrence.
 *
 * ## Bumping it
 *
 * Read the changelog for the Posts, Images, Documents and Social Actions APIs
 * first; a version bump can change response shapes, not just the header.
 * LinkedIn publishes the sunset date for each version — bump before it, not
 * after. `linkedin-version.spec.ts` asserts the format and that both call
 * sites use this constant rather than a literal.
 */
export const LINKEDIN_REST_VERSION = '202610';

/**
 * The header name, in LinkedIn's own documented spelling.
 *
 * ⚠ Capitalised as `Linkedin-Version`, not `LinkedIn-Version`. HTTP header
 * names are case-insensitive per RFC 9110, and LinkedIn does accept both — the
 * analytics adapter sent `LinkedIn-Version` for years and its only problem was
 * the stale value. It is unified here anyway so a future grep for the header
 * finds every sender, which is exactly what did not happen last time.
 */
export const LINKEDIN_VERSION_HEADER = 'Linkedin-Version';
