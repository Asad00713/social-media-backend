import { STATIC_SYSTEM_PROMPT, todayPolicy } from './system-prompt';

/**
 * The search policy exists to stop two opposite failures, and a test that only
 * guards one of them is worthless.
 *
 * Under-searching: answering "what's the latest X" from training data, with
 * full confidence and a year-old fact. The user cannot tell, because a stale
 * answer reads exactly like a current one.
 *
 * Over-searching: googling the user's own drafts, or a caption request. That
 * burns a turn and money to learn nothing the workspace tools already knew.
 *
 * These are prompt tests, so they assert the INSTRUCTION is present and
 * unambiguous -- they cannot prove the model obeys it. Model behaviour is
 * checked live; see the Maestro UI notes on prompt-vs-code.
 */
describe('web search policy', () => {
  const prompt = STATIC_SYSTEM_PROMPT;

  it('tells the model to search when the user explicitly asks, even if it thinks it knows', () => {
    // The failure this prevents: the model weighing "do I know this?" against
    // a direct instruction. An instruction is not a hint.
    const section = prompt.slice(prompt.indexOf('## Web search'));
    expect(section).toMatch(/even if you think you know/i);
    expect(section.toLowerCase()).toContain('google it');
  });

  it('names time-bound triggers rather than leaving "current" to judgement', () => {
    // "Search when you don't know" was the OLD rule, and it failed because
    // the model usually believes it knows. Concrete triggers remove that
    // judgement call.
    const section = prompt.slice(prompt.indexOf('## Web search'));
    for (const trigger of ['latest', 'news', 'prices', 'today']) {
      expect(section.toLowerCase()).toContain(trigger);
    }
  });

  it('tells the model its own training data may be stale', () => {
    const section = prompt.slice(prompt.indexOf('## Web search'));
    expect(section).toMatch(/cutoff/i);
    // The specific trap: feeling sure is not evidence of being current.
    expect(section).toMatch(/confidence is not recency/i);
  });

  it('carries an explicit DO NOT SEARCH list, not only reasons to search', () => {
    // Without this half the model searches the web for the user's own drafts.
    const section = prompt.slice(prompt.indexOf('## Web search'));
    expect(section).toContain('DO NOT SEARCH');
    expect(section.toLowerCase()).toContain('captions');
    // Their own data has dedicated tools; the web does not hold it.
    expect(section.toLowerCase()).toMatch(/workspace|their own account/);
  });

  it('orders search before the answer, not after it', () => {
    // Answering first and checking afterwards produces a confident wrong
    // paragraph followed by a correction -- worse than either alone.
    const section = prompt.slice(prompt.indexOf('## Web search'));
    expect(section).toMatch(/Search FIRST, then answer/i);
  });

  it('routes post images to licensed stock and real-world images to the web', () => {
    // Publishing an unlicensed web image is a legal problem for the user, so
    // the split has to be stated, not inferred.
    const section = prompt.slice(prompt.indexOf('## Web search'));
    expect(section).toContain('search_media');
    expect(section).toMatch(/not licensed for publishing/i);
  });

  it('forbids falling back to a remembered guess when a search finds nothing', () => {
    const section = prompt.slice(prompt.indexOf('## Web search'));
    expect(section).toMatch(/do not fall back to a remembered guess/i);
  });
});

describe('todayPolicy', () => {
  it("states today's date, so staleness is computable", () => {
    // Without a date the model cannot judge how far past its cutoff we are,
    // which makes every "is this current?" question unanswerable.
    const block = todayPolicy(new Date('2026-10-01T18:30:00Z'));
    expect(block).toContain('2026-10-01');
  });

  it('carries no clock time', () => {
    // This block sits in the cached prefix. A date changes it once a day; a
    // clock would change it every turn and the prefix would never be read
    // back. This is the whole reason the block is date-only.
    const block = todayPolicy(new Date('2026-10-01T18:30:00Z'));
    expect(block).not.toMatch(/\d{2}:\d{2}/);
  });

  it('is stable across a whole day and changes on the next', () => {
    const morning = todayPolicy(new Date('2026-10-01T00:01:00Z'));
    const night = todayPolicy(new Date('2026-10-01T23:59:00Z'));
    const tomorrow = todayPolicy(new Date('2026-10-02T00:01:00Z'));
    expect(morning).toBe(night);
    expect(tomorrow).not.toBe(morning);
  });

  it('refuses to become a scheduling input', () => {
    // The planner rules forbid deriving weekdays and hours -- entries arrive
    // pre-formatted in the user's zone. Handing the model a date must not
    // quietly reopen that, or it will start computing "tomorrow" in UTC for a
    // user in another zone.
    const block = todayPolicy(new Date('2026-10-01T18:30:00Z'));
    expect(block).toMatch(/NOT a scheduling input/i);
    expect(block).toMatch(/never compute/i);
  });
});
