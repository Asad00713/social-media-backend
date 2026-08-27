import { confirmCard, isConfirmed } from './confirm';

/**
 * The confirm gate is what stops Maestro performing an outward action — a real
 * Slack message, a real post — without asking first. The guarantee it makes is
 * narrow and worth pinning down: only a literal boolean `true` opens it.
 */
describe('confirm gate', () => {
  describe('isConfirmed', () => {
    it('proceeds when the workspace has confirmation turned off', () => {
      expect(isConfirmed(false, {})).toBe(true);
    });

    it('refuses the first call when confirmation is on', () => {
      expect(isConfirmed(true, {})).toBe(false);
    });

    it('proceeds on the re-call the model makes after approval', () => {
      expect(isConfirmed(true, { confirmed: true })).toBe(true);
    });

    // The gate exists because a prompt-only policy lets weaker models narrate
    // "Confirm?" without ever showing buttons. A truthy check here would
    // reopen that hole from the other side: a model echoing the string
    // "true", or a stray 1, would be enough to send a real message unasked.
    it.each([
      ['the string "true"', 'true'],
      ['the number 1', 1],
      ['the string "yes"', 'yes'],
      ['an object', {}],
      ['an array', []],
      ['the string "confirmed"', 'confirmed'],
    ])('does not accept %s as approval', (_label, value) => {
      expect(isConfirmed(true, { confirmed: value })).toBe(false);
    });

    it('does not accept falsy look-alikes either', () => {
      expect(isConfirmed(true, { confirmed: false })).toBe(false);
      expect(isConfirmed(true, { confirmed: null })).toBe(false);
      expect(isConfirmed(true, { confirmed: undefined })).toBe(false);
    });
  });

  describe('confirmCard', () => {
    const card = confirmCard('Send "hello" to #general on Slack?', 'Yes, send it');

    it('renders through the same question path as ask_user', () => {
      // `kind: 'question'` is what makes the frontend show real Yes/No
      // buttons with no extra wiring — the whole reason the gate returns a
      // card rather than plain text.
      expect(card.kind).toBe('question');
      expect(card.shown).toBe(true);
    });

    it('offers exactly two options, affirmative first', () => {
      expect(card.questions).toHaveLength(1);
      expect(card.questions[0].options).toEqual(['Yes, send it', 'No, cancel']);
      expect(card.questions[0].multiSelect).toBe(false);
    });

    it('carries the caller summary as the question', () => {
      expect(card.questions[0].question).toBe(
        'Send "hello" to #general on Slack?',
      );
      expect(card.questions[0].header).toBe('Confirm');
    });

    it('tells the model to re-call with confirmed:true rather than answer in prose', () => {
      expect(card.instruction).toContain('confirmed:true');
      expect(card.instruction).toContain('Yes, send it');
    });
  });
});
