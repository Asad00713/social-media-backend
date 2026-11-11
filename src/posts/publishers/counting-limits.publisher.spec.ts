import { BlueskyPublisher } from './bluesky.publisher';
import { InstagramPublisher } from './instagram.publisher';
import { MastodonPublisher } from './mastodon.publisher';
import { PinterestPublisher } from './pinterest.publisher';
import { ThreadsPublisher } from './threads.publisher';
import { TikTokPublisher } from './tiktok.publisher';
import { TwitterPublisher } from './twitter.publisher';
import { YouTubePublisher } from './youtube.publisher';
import type { PublishOptions } from './base.publisher';

/**
 * validate() counts each network's way and holds each network's documented
 * limit — the same measure the composer's counter and Checks use
 * (`text-length.ts` on both sides). Every case is a post the composer calls
 * fine that this used to refuse, or the other way round.
 */
const svc = {} as never;

function opts(partial: Partial<PublishOptions>): PublishOptions {
  return {
    content: '',
    mediaItems: [],
    accessToken: 't',
    platformAccountId: 'a',
    channelMetadata: {},
    channelId: 1,
    metadata: {},
    ...partial,
  } as PublishOptions;
}

const LONG_URL = `https://example.com/${'p'.repeat(300)}`;
const image = { url: 'https://cdn/a.jpg', type: 'image' } as const;
const video = (extra: Record<string, unknown> = {}) =>
  ({ url: 'https://cdn/a.mp4', type: 'video', ...extra }) as never;

describe('X — weighted counting', () => {
  const x = new TwitterPublisher(svc);

  it('takes a 300+ character caption that is mostly one URL', () => {
    const content = `Read this ${LONG_URL}`;
    expect(content.length).toBeGreaterThan(280);
    expect(() => x.validate(opts({ content }))).not.toThrow();
  });

  it('refuses 141 emoji (282 weighted)', () => {
    expect(() => x.validate(opts({ content: '😀'.repeat(141) }))).toThrow(
      '282 chars',
    );
  });
});

describe('Bluesky — graphemes', () => {
  const bsky = new BlueskyPublisher(svc);
  it('takes 300 emoji (300 graphemes, 600 code units)', () => {
    expect(() =>
      bsky.validate(opts({ content: '😀'.repeat(300) })),
    ).not.toThrow();
  });
  it('refuses 301', () => {
    expect(() => bsky.validate(opts({ content: '😀'.repeat(301) }))).toThrow(
      '301 chars',
    );
  });
});

describe('Mastodon — 23 per link, and the content warning counts', () => {
  const masto = new MastodonPublisher(svc);
  it('takes a long link as 23', () => {
    expect(() =>
      masto.validate(opts({ content: `${'a'.repeat(470)} ${LONG_URL}` })),
    ).not.toThrow();
  });
  it('charges the content warning', () => {
    expect(() =>
      masto.validate(
        opts({
          content: 'y'.repeat(495),
          metadata: { contentWarning: 'x'.repeat(10) },
        }),
      ),
    ).toThrow('505 chars');
  });
  it('checks every post of a thread', () => {
    expect(() =>
      masto.validate(
        opts({
          content: 'one',
          metadata: {
            postType: 'thread',
            thread: [{ text: 'one' }, { text: 'z'.repeat(501) }],
          },
        }),
      ),
    ).toThrow('Mastodon thread post 2');
  });
});

describe('Threads — emoji bytes, 20 items', () => {
  const threads = new ThreadsPublisher(svc);
  it('refuses 126 emoji (504 bytes)', () => {
    expect(() =>
      threads.validate(opts({ content: '😀'.repeat(126) })),
    ).toThrow('504 chars');
  });
  it('takes 20 items and refuses 21', () => {
    const items = (n: number) => Array.from({ length: n }, () => image);
    expect(() =>
      threads.validate(opts({ content: 'x', mediaItems: items(20) })),
    ).not.toThrow();
    expect(() =>
      threads.validate(opts({ content: 'x', mediaItems: items(21) })),
    ).toThrow('maximum 20');
  });
});

describe('YouTube — bytes, angle brackets, tags, Shorts', () => {
  const yt = new YouTubePublisher(svc, svc);
  const base = { title: 'T' };

  it('counts the description in bytes', () => {
    expect(() =>
      yt.validate(
        opts({
          mediaItems: [video()],
          metadata: { ...base, description: '😀'.repeat(1300) },
        }),
      ),
    ).toThrow('5000 bytes (5200 given)');
  });

  it('refuses < and >', () => {
    expect(() =>
      yt.validate(opts({ mediaItems: [video()], metadata: { title: 'a <b>' } })),
    ).toThrow('< or >');
  });

  it('refuses tags over 500 counted YouTube’s way', () => {
    const tags = Array.from({ length: 50 }, () => 'ten chars!');
    expect(() =>
      yt.validate(opts({ mediaItems: [video()], metadata: { ...base, tags } })),
    ).toThrow('649 given');
  });

  it('reads the composer’s `durationSec`: a 200 s Short is over 3 minutes', () => {
    expect(() =>
      yt.validate(
        opts({
          mediaItems: [video({ durationSec: 200 })],
          metadata: { ...base, isShort: true },
        }),
      ),
    ).toThrow('180 seconds');
  });

  it('takes a 2-minute Short (the old limit was 60 s)', () => {
    expect(() =>
      yt.validate(
        opts({
          mediaItems: [video({ durationSec: 120, width: 1080, height: 1920 })],
          metadata: { ...base, isShort: true },
        }),
      ),
    ).not.toThrow();
  });
});

describe('Instagram — 30 hashtags, 20 mentions', () => {
  const ig = new InstagramPublisher(svc);
  const tags = (n: number, sign: string) =>
    Array.from({ length: n }, (_, i) => `${sign}t${i}`).join(' ');

  it('takes 30 hashtags and refuses 31', () => {
    expect(() =>
      ig.validate(opts({ content: tags(30, '#'), mediaItems: [image] })),
    ).not.toThrow();
    expect(() =>
      ig.validate(opts({ content: tags(31, '#'), mediaItems: [image] })),
    ).toThrow('30 hashtags');
  });

  it('takes 20 mentions and refuses 21', () => {
    expect(() =>
      ig.validate(opts({ content: tags(20, '@'), mediaItems: [image] })),
    ).not.toThrow();
    expect(() =>
      ig.validate(opts({ content: tags(21, '@'), mediaItems: [image] })),
    ).toThrow('20 @mentions');
  });
});

describe('TikTok — 4000 on a Photo, 2200 on a Video', () => {
  const tiktok = new TikTokPublisher(svc, svc, svc);
  const meta = (postType: string) => ({
    postType,
    privacyLevel: 'PUBLIC_TO_EVERYONE',
  });

  it('takes a 3000-character Photo description', () => {
    expect(() =>
      tiktok.validate(
        opts({
          content: 'a'.repeat(3000),
          mediaItems: [image],
          metadata: meta('photo'),
        }),
      ),
    ).not.toThrow();
  });

  it('refuses a 3000-character Video caption', () => {
    expect(() =>
      tiktok.validate(
        opts({
          content: 'a'.repeat(3000),
          mediaItems: [video()],
          metadata: meta('video'),
        }),
      ),
    ).toThrow('2200');
  });
});

describe('Pinterest — the destination link', () => {
  const pin = new PinterestPublisher(svc);
  const meta = (destinationLink: string) => ({
    boardId: 'b',
    title: 'T',
    destinationLink,
  });

  it('refuses a link that is not a web address', () => {
    expect(() =>
      pin.validate(opts({ mediaItems: [image], metadata: meta('example.com') })),
    ).toThrow('full web address');
  });

  it('takes an https link', () => {
    expect(() =>
      pin.validate(
        opts({ mediaItems: [image], metadata: meta('https://example.com') }),
      ),
    ).not.toThrow();
  });
});
