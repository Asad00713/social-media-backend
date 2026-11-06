/**
 * The button on a Facebook link post - `call_to_action` on `POST /{page-id}/feed`.
 *
 * Meta's Page feed reference: "call_to_action can be added to new link Page
 * posts", as `{"type": "SIGN_UP", "value": {"link": "..."}}`, and the link in
 * it "should be the same as the link parameter of the Page post".
 */

/**
 * The first URL in a block of text.
 *
 * KEEP IN STEP with the composer's `findLink`
 * (`src/features/composer-v2/lib/facebook-post-shape.ts` in the frontend): the
 * composer decides a draft is a link post from this match, and the publisher
 * must find the same link or the button would go to a different URL than the
 * card shows. Deliberately loose about the end of the match - a trailing full
 * stop or comma belongs to the sentence, not the link.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/i;

export function findFirstLink(text: string): string | undefined {
  return text.match(URL_PATTERN)?.[0];
}

/**
 * The composer's button choices that Facebook documents for a Page post, and
 * the type each one is sent as.
 *
 * Only these two (plus "no button", which is the absence of a button).
 * The reference lists a type's restrictions beside it, and the rest of the
 * composer's menu has nothing to offer a Page post:
 *   - `shop`    SHOP_NOW is "only for ads with the Website Conversions objective"
 *   - `order`   no ORDER_NOW in the list
 *   - `contact` no CONTACT_US in the list
 *   - `book`    the only booking type listed is BOOK_TRAVEL, which Meta uses for
 *                travel ads; it is not "Book now", so it is not guessed at
 * so they are NOT sent. Sending one would either be ignored or reject the
 * whole post.
 */
const CTA_TYPES: ReadonlyMap<string, string> = new Map([
  ['learn', 'LEARN_MORE'],
  ['signup', 'SIGN_UP'],
]);

/** The API type for a composer button choice, or undefined when none is sent. */
export function linkCallToActionType(choice: unknown): string | undefined {
  return typeof choice === 'string' ? CTA_TYPES.get(choice) : undefined;
}
