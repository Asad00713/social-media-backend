import { withoutCadenceJudgement } from './maestro.service';

/**
 * The prompt asked the model not to judge a posting schedule it knows nothing
 * about, and the model wrote "Add more posts to fill the gaps" anyway — twice,
 * in a follow-up chip. A prompt can only ask; this is the part that guarantees.
 */
describe('withoutCadenceJudgement', () => {
  it('drops the judgement from a suggestion that already says what to do', () => {
    expect(withoutCadenceJudgement('Add more posts to fill the gaps')).toBe(
      'Add more posts',
    );
  });

  it('turns a standalone fill-the-gaps into adding posts', () => {
    expect(withoutCadenceJudgement('Fill the gaps')).toBe('add posts');
  });

  it('rewrites a bare gap as the empty days it means', () => {
    expect(withoutCadenceJudgement('Add posts for the gaps')).toBe(
      'Add posts for the empty days',
    );
  });

  it('replaces cadence and rhythm with the neutral word', () => {
    expect(withoutCadenceJudgement('Improve my posting cadence')).toBe(
      'Improve my schedule',
    );
    expect(withoutCadenceJudgement('Fix my posting rhythm')).toBe(
      'Fix my schedule',
    );
  });

  it('leaves a suggestion that judges nothing exactly as written', () => {
    for (const ok of [
      'Add a post on Wednesday',
      "Check next week's calendar",
      'View this post in detail',
    ]) {
      expect(withoutCadenceJudgement(ok)).toBe(ok);
    }
  });

  // The regex is module-scoped and global; a stale lastIndex would make every
  // other call skip its match.
  it('holds across repeated calls', () => {
    const once = withoutCadenceJudgement('Fill the gaps');
    expect(withoutCadenceJudgement('Fill the gaps')).toBe(once);
    expect(withoutCadenceJudgement('Fill the gaps')).toBe(once);
  });
});
