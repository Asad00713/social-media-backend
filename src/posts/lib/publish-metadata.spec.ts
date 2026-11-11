import { sharedMetadataFor } from './publish-metadata';

/** D1, read side: a shared thread or poll is never another platform's. */
describe('sharedMetadataFor', () => {
  const THREAD = [{ text: 'x one' }, { text: 'x two' }];
  const stored = {
    hashtags: ['coffee'],
    source: 'composer',
    thread: THREAD,
    poll: { options: ['a', 'b'], durationMinutes: 60 },
  };

  it.each(['bluesky', 'mastodon', 'threads', 'linkedin', 'facebook'])(
    'hands %s no thread and no poll, with or without fields of its own',
    (platform) => {
      for (const own of [undefined, {}, { postType: 'post' }]) {
        const out = sharedMetadataFor(stored, platform, own);
        expect(out.thread).toBeUndefined();
        expect(out.poll).toBeUndefined();
        // Everything genuinely shared still goes.
        expect(out.hashtags).toEqual(['coffee']);
        expect(out.source).toBe('composer');
      }
    },
  );

  it('drops the copy for X too when X has fields of its own', () => {
    const out = sharedMetadataFor(stored, 'twitter', { postType: 'post' });
    expect(out.thread).toBeUndefined();
    expect(out.poll).toBeUndefined();
  });

  it('keeps it for an X target with no fields of its own (pre-composer row)', () => {
    const out = sharedMetadataFor(stored, 'twitter', undefined);
    expect(out.thread).toEqual(THREAD);
    expect(out.poll).toEqual(stored.poll);
  });

  it('never mutates the stored metadata', () => {
    sharedMetadataFor(stored, 'bluesky', undefined);
    expect(stored.thread).toBe(THREAD);
  });

  it('copes with a row that has no metadata', () => {
    expect(sharedMetadataFor(null, 'bluesky', undefined)).toEqual({});
  });
});
