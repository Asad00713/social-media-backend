import { newContactReference } from './contact-reference';

describe('newContactReference', () => {
  it('is SCH- and 6 Crockford base32 characters', () => {
    for (let i = 0; i < 500; i++) {
      expect(newContactReference()).toMatch(/^SCH-[0-9A-HJKMNP-TV-Z]{6}$/);
    }
  });

  it('is random: 100 references are all different', () => {
    const refs = new Set(
      Array.from({ length: 100 }, () => newContactReference()),
    );
    // 32^6 is about a billion values; a repeat in 100 draws means no entropy.
    expect(refs.size).toBe(100);
  });

  it('fits an idempotency key', () => {
    // `contact.SCH-XXXXXX`: letters, digits, dots and dashes only.
    expect(`contact.${newContactReference()}`).toMatch(
      /^[A-Za-z0-9._-]{1,200}$/,
    );
  });
});
