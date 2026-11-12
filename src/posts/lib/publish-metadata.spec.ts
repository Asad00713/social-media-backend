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

/**
 * The draft title. The composer stores the DRAFT's name as the shared
 * `metadata.title`; Pinterest, YouTube, Reddit and TikTok read
 * `metadata.title` as the post title. "Publish now" hands a publisher only
 * the channel's own fields, so a scheduled post must not get the draft's
 * name where publish-now gets none.
 */
describe('sharedMetadataFor - draft title', () => {
  const PLATFORMS = ['pinterest', 'youtube', 'reddit', 'tiktok', 'twitter'];

  it.each(PLATFORMS)(
    'never hands %s the draft title from a scheduled composer row',
    (platform) => {
      const stored = { title: 'My draft', source: 'composer', hashtags: [] };
      for (const own of [undefined, {}, { postType: 'post' }]) {
        expect(sharedMetadataFor(stored, platform, own).title).toBeUndefined();
      }
    },
  );

  it('drops it from a draft-store / publish-now row (no source, has schedule)', () => {
    const stored = { title: 'My draft', schedule: { mode: 'now' } };
    expect(
      sharedMetadataFor(stored, 'pinterest', undefined).title,
    ).toBeUndefined();
  });

  it('drops it whenever the channel has fields of its own', () => {
    const stored = { title: 'Legacy title' };
    expect(
      sharedMetadataFor(stored, 'youtube', { privacyStatus: 'public' }).title,
    ).toBeUndefined();
  });

  it('keeps it on a pre-composer API row with no per-platform fields', () => {
    const stored = { title: 'Legacy YouTube title', hashtags: ['a'] };
    expect(sharedMetadataFor(stored, 'youtube', undefined).title).toBe(
      'Legacy YouTube title',
    );
  });

  it('never mutates the stored metadata', () => {
    const stored = { title: 'My draft', source: 'composer' };
    sharedMetadataFor(stored, 'pinterest', undefined);
    expect(stored.title).toBe('My draft');
  });
});
