import { threadgateAllow, postLangs } from './bluesky.service';

/**
 * The reply control, which is the subtle one on this platform: Bluesky has
 * no field on the post for it. The restriction is a separate
 * `app.bsky.feed.threadgate` record, and the absence of that record is
 * itself a meaning — "anyone may reply".
 *
 * So there are THREE outcomes where a naive mapping sees two, and the two
 * that look alike are opposites: no record at all versus a record with an
 * empty `allow`.
 */
describe('threadgateAllow', () => {
  // null means "write no record". An empty array would say nobody may
  // reply — the exact opposite of what the author chose.
  it.each([
    ['everybody is chosen', { replyControl: 'everybody' as const }],
    ['nothing was chosen', {}],
    ['there are no settings', undefined],
  ])('writes no record when %s', (_label, settings) => {
    expect(threadgateAllow(settings)).toBeNull();
  });

  it('writes an empty allow list for nobody', () => {
    expect(threadgateAllow({ replyControl: 'nobody' })).toEqual([]);
  });

  it('maps each custom rule to the lexicon spelling', () => {
    expect(
      threadgateAllow({
        replyControl: 'custom',
        replyRules: { followers: true, following: true, mentioned: true },
      }),
    ).toEqual([
      'app.bsky.feed.threadgate#followerRule',
      'app.bsky.feed.threadgate#followingRule',
      'app.bsky.feed.threadgate#mentionRule',
    ]);
  });

  it('sends only the rules that were ticked', () => {
    expect(
      threadgateAllow({
        replyControl: 'custom',
        replyRules: { mentioned: true },
      }),
    ).toEqual(['app.bsky.feed.threadgate#mentionRule']);
  });

  // `allow: []` is what "nobody" means, so a custom choice with nothing
  // ticked lands there rather than on "everybody" — the author opened the
  // custom panel and allowed no one.
  it.each([
    ['no rules are ticked', {}],
    ['every rule is off', { followers: false, following: false }],
  ])('collapses custom to nobody when %s', (_label, replyRules) => {
    expect(threadgateAllow({ replyControl: 'custom', replyRules })).toEqual(
      [],
    );
  });
});

describe('postLangs', () => {
  it('sends the chosen language as a list', () => {
    expect(postLangs({ langs: ['ur'] })).toEqual(['ur']);
  });

  // The lexicon's own cap.
  it('sends at most three', () => {
    expect(postLangs({ langs: ['en', 'ur', 'ar', 'fr'] })).toEqual([
      'en',
      'ur',
      'ar',
    ]);
  });

  it.each([
    ['nothing was chosen', undefined],
    ['the list is empty', []],
    ['the code is blank', ['  ']],
  ])('sends nothing when %s', (_label, langs) => {
    expect(postLangs(langs ? { langs } : {})).toBeUndefined();
  });

  it('trims the code', () => {
    expect(postLangs({ langs: ['  en  '] })).toEqual(['en']);
  });
});
