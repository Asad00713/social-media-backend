import { tonePolicy } from './system-prompt';
import { MAESTRO_TONES } from '../../drizzle/schema/users.schema';

/**
 * These tests guard the ONE thing tone must never do: change what is true.
 *
 * Tone shapes how an answer reads. A tone block that quietly licensed dropping
 * a citation, skipping a tool call, or guessing would trade correctness for
 * readability -- a simpler wording of a wrong answer is still a wrong answer.
 */
describe('tonePolicy', () => {
  it('costs nothing for the default voice', () => {
    // 'professional' IS the static prompt's voice. Emitting a block for it
    // would spend tokens restating what the prompt already says -- and risk
    // drifting from it.
    expect(tonePolicy('professional')).toBe('');
  });

  it.each(['simple', 'detailed'] as const)(
    'gives %s an actual instruction block',
    (tone) => {
      expect(tonePolicy(tone).length).toBeGreaterThan(100);
    },
  );

  it.each(['simple', 'detailed'] as const)(
    'never lets %s trade away grounding or citations',
    (tone) => {
      const block = tonePolicy(tone);
      // Both non-default blocks must restate the two invariants, because they
      // are appended AFTER the static prompt and would otherwise read as
      // permission to relax it.
      expect(block).toMatch(/citation marker/i);
      expect(block).toMatch(/tool result/i);
    },
  );

  it('tells the simple voice to drop jargon and stay short', () => {
    const block = tonePolicy('simple');
    expect(block).toMatch(/everyday words/i);
    expect(block).toMatch(/2-4 short sentences/i);
    // "Simple" must not slide into condescension -- the block says so out loud.
    expect(block).toMatch(/never talk down/i);
  });

  it('tells the detailed voice to explain without padding', () => {
    const block = tonePolicy('detailed');
    expect(block).toMatch(/trade-off/i);
    // Detailed means more substance, not more words.
    expect(block).toMatch(/never longer for its own sake/i);
  });

  it('covers every tone the schema allows', () => {
    // A tone added to the enum without a policy would silently fall through to
    // the default block, and nobody would notice until a user picked it.
    for (const tone of MAESTRO_TONES) {
      expect(() => tonePolicy(tone)).not.toThrow();
    }
    expect(MAESTRO_TONES).toHaveLength(3);
  });
});
