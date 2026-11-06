/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- test doubles are loosely typed */
import {
  EXCERPT_MAX,
  describeChange,
  readVersion,
  sameSnapshot,
  snapshotOf,
  type DraftSnapshot,
} from './draft-versions';

const img = (id: string) => ({
  id,
  type: 'image' as const,
  url: `https://x/${id}`,
  sizeBytes: 1,
});
const vid = (id: string) => ({ ...img(id), type: 'video' as const });

function snap(over: Partial<DraftSnapshot> = {}): DraftSnapshot {
  return {
    text: 'Hello',
    mediaItems: [],
    hashtags: [],
    mentions: [],
    perPlatform: {},
    channels: [{ channelId: '7', platform: 'facebook' }],
    ...over,
  };
}

describe('snapshotOf', () => {
  it('keeps the content and only the channel ids of the targets', () => {
    const s = snapshotOf({
      base: {
        text: 'Hi',
        mediaItems: [img('a')],
        hashtags: ['x'],
        mentions: [],
        linkPreview: { url: 'https://l' },
      },
      perPlatform: { x: { inheritsFromBase: true } } as any,
      channels: [
        {
          channelId: '7',
          platform: 'facebook',
          publishStatus: 'published',
          platformPostId: 'p1',
          retryCount: 2,
        },
      ],
      title: 'T',
    });
    expect(s).toEqual({
      text: 'Hi',
      mediaItems: [img('a')],
      hashtags: ['x'],
      mentions: [],
      linkPreview: { url: 'https://l' },
      perPlatform: { x: { inheritsFromBase: true } },
      channels: [{ channelId: '7', platform: 'facebook' }],
      title: 'T',
    });
  });
});

describe('sameSnapshot', () => {
  it('ignores key order, which jsonb does not keep', () => {
    const a = snap({ perPlatform: { x: { a: 1, b: 2 } } as any });
    const reordered = JSON.parse(
      '{"channels":[{"platform":"facebook","channelId":"7"}],"perPlatform":{"x":{"b":2,"a":1}},"mentions":[],"hashtags":[],"mediaItems":[],"text":"Hello"}',
    );
    expect(sameSnapshot(a, reordered)).toBe(true);
  });

  it('sees a real change', () => {
    expect(sameSnapshot(snap(), snap({ text: 'Hello!' }))).toBe(false);
    expect(sameSnapshot(snap(), snap({ title: 'T' }))).toBe(false);
  });
});

describe('describeChange', () => {
  it('names the first version "created"', () => {
    expect(describeChange(null, snap())).toEqual({ kind: 'created' });
  });

  it('quotes the new caption, cut to EXCERPT_MAX', () => {
    expect(describeChange(snap(), snap({ text: 'This weekend only' }))).toEqual(
      { kind: 'caption', excerpt: 'This weekend only' },
    );
    const long = 'word '.repeat(30);
    const c = describeChange(snap(), snap({ text: long }));
    expect(c.kind).toBe('caption');
    expect((c as { excerpt: string }).excerpt).toHaveLength(EXCERPT_MAX);
    expect((c as { excerpt: string }).excerpt.endsWith('…')).toBe(true);
  });

  it('counts media added and removed by id, with the right noun', () => {
    const before = snap({ mediaItems: [img('a')] });
    expect(
      describeChange(
        before,
        snap({ mediaItems: [img('a'), img('b'), img('c'), img('d')] }),
      ),
    ).toEqual({ kind: 'media_added', count: 3, noun: 'photo' });
    expect(describeChange(before, snap({ mediaItems: [] }))).toEqual({
      kind: 'media_removed',
      count: 1,
      noun: 'photo',
    });
    // A swap is a change even though the count is the same.
    expect(describeChange(before, snap({ mediaItems: [vid('v')] }))).toEqual({
      kind: 'media_added',
      count: 1,
      noun: 'video',
    });
    expect(
      describeChange(snap(), snap({ mediaItems: [img('a'), vid('v')] })),
    ).toEqual({ kind: 'media_added', count: 2, noun: 'file' });
  });

  it('then channels, then "edited"', () => {
    expect(
      describeChange(
        snap(),
        snap({ channels: [{ channelId: '8', platform: 'x' as any }] }),
      ),
    ).toEqual({ kind: 'channels' });
    expect(describeChange(snap(), snap({ hashtags: ['x'] }))).toEqual({
      kind: 'edited',
    });
  });
});

describe('readVersion', () => {
  it('accepts a snapshot row and refuses anything else', () => {
    const d = { snapshot: snap(), change: { kind: 'created' } };
    expect(readVersion(d)).toBe(d);
    expect(readVersion(null)).toBeNull();
    expect(readVersion({ platformPostId: 'p' })).toBeNull();
    expect(readVersion({ snapshot: snap() })).toBeNull();
  });
});
