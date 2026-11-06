import { findFirstLink, linkCallToActionType } from './facebook-link-cta';

describe('findFirstLink', () => {
  it('finds the first URL in the text', () => {
    expect(
      findFirstLink('Autumn menu is out https://lumiere.pk/menu?x=1 and more'),
    ).toBe('https://lumiere.pk/menu?x=1');
    expect(findFirstLink('a https://one.example b https://two.example')).toBe(
      'https://one.example',
    );
  });

  it('leaves a sentence’s trailing punctuation out of the link', () => {
    // The composer's own match does the same; a link that ended in a full stop
    // would point somewhere that does not resolve.
    expect(findFirstLink('Read https://lumiere.pk/menu.')).toBe(
      'https://lumiere.pk/menu',
    );
    expect(findFirstLink('(see https://lumiere.pk/menu), thanks')).toBe(
      'https://lumiere.pk/menu',
    );
  });

  it('is undefined when there is no link', () => {
    expect(findFirstLink('no link here, only www.example.com')).toBeUndefined();
    expect(findFirstLink('')).toBeUndefined();
  });
});

describe('linkCallToActionType', () => {
  it('maps the choices Facebook documents for a Page post', () => {
    expect(linkCallToActionType('learn')).toBe('LEARN_MORE');
    expect(linkCallToActionType('signup')).toBe('SIGN_UP');
  });

  it('sends nothing for the choices the reference restricts or omits', () => {
    // SHOP_NOW is ads-only; ORDER_NOW and CONTACT_US are not in the list; the
    // one booking type, BOOK_TRAVEL, is a travel-ads type, not "Book now".
    expect(linkCallToActionType('book')).toBeUndefined();
    expect(linkCallToActionType('shop')).toBeUndefined();
    expect(linkCallToActionType('order')).toBeUndefined();
    expect(linkCallToActionType('contact')).toBeUndefined();
  });

  it('sends nothing for "no button", nothing set, or a stray value', () => {
    expect(linkCallToActionType('none')).toBeUndefined();
    expect(linkCallToActionType(undefined)).toBeUndefined();
    expect(linkCallToActionType(null)).toBeUndefined();
    expect(linkCallToActionType(7)).toBeUndefined();
    // Not an own key of a plain object lookup.
    expect(linkCallToActionType('constructor')).toBeUndefined();
  });

  it('is exact: no case folding, no trimming', () => {
    expect(linkCallToActionType('LEARN')).toBeUndefined();
    expect(linkCallToActionType(' learn')).toBeUndefined();
  });
});
