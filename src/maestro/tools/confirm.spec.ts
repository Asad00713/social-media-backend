import {
  CANCEL_LABEL,
  confirmCard,
  isConfirmed,
  stampPendingAction,
} from './confirm';

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
    const card = confirmCard(
      'Send "hello" to #general on Slack?',
      'Yes, send it',
    );

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

  describe('stampPendingAction', () => {
    // The card must remember who asked and with what, so an approval can
    // re-invoke that exact handler instead of the model re-deriving it from
    // chat text — which is what produced the duplicate-confirm bug.
    const args = { channel: 'schedura-channel', message: 'Hello' };

    it('records the asking tool and its arguments', () => {
      const stamped = stampPendingAction(
        confirmCard('Send "Hello" to #schedura-channel?', 'Yes, send it'),
        'send_slack_message',
        args,
      ) as { pendingAction?: unknown };

      expect(stamped.pendingAction).toEqual({
        tool: 'send_slack_message',
        args,
        yesLabel: 'Yes, send it',
      });
    });

    // It was falsy on the call that produced the card, and the approval path
    // sets it itself — carrying it would only invite it to go stale.
    it('drops the confirmed flag from the recorded arguments', () => {
      const stamped = stampPendingAction(
        confirmCard('Send it?', 'Yes, send it'),
        'send_slack_message',
        { ...args, confirmed: false },
      ) as { pendingAction: { args: Record<string, unknown> } };

      expect(stamped.pendingAction.args).toEqual(args);
      expect(stamped.pendingAction.args).not.toHaveProperty('confirmed');
    });

    it('leaves an ordinary tool result untouched', () => {
      const result = { kind: 'slack', ok: true, message: 'sent' };

      expect(stampPendingAction(result, 'send_slack_message', args)).toBe(
        result,
      );
    });

    // ask_user questions flow through the same wrapper but are not gates —
    // there is no action pending behind them.
    it('does not stamp an ask_user question', () => {
      const question = {
        kind: 'question',
        shown: true,
        questions: [
          {
            header: 'Tone',
            question: 'Which tone?',
            options: ['Friendly', 'Formal'],
            multiSelect: false,
          },
        ],
      };

      const stamped = stampPendingAction(question, 'ask_user', {}) as {
        pendingAction?: unknown;
      };

      expect(stamped.pendingAction).toBeUndefined();
    });

    it('never overwrites a stamp that is already there', () => {
      const already = {
        ...confirmCard('Send it?', 'Yes, send it'),
        pendingAction: { tool: 'original', args: {}, yesLabel: 'Yes, send it' },
      };

      const stamped = stampPendingAction(already, 'other_tool', args) as {
        pendingAction: { tool: string };
      };

      expect(stamped.pendingAction.tool).toBe('original');
    });

    it('uses the shared cancel label as the negative option', () => {
      expect(
        confirmCard('Send it?', 'Yes, send it').questions[0].options[1],
      ).toBe(CANCEL_LABEL);
    });
  });
});
