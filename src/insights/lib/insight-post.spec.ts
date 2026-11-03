import type { PublishedPost } from '../../post-performance/post-performance';
import {
  classifyFormat,
  firstLine,
  isSettling,
  POST_FORMATS,
  toInsightPost,
} from './insight-post';

const NOW = new Date('2026-09-22T12:00:00.000Z');

const post = (over: Partial<PublishedPost>): PublishedPost => ({
  postId: 'p1',
  channelId: 1,
  publishedOn: '2026-09-20',
  likes: null,
  comments: null,
  shares: null,
  impressions: null,
  reach: null,
  saved: null,
  follows: null,
  syncedAt: null,
  publishedAt: '2026-09-20T10:00:00.000Z',
  content: '',
  mediaItems: [],
  imported: false,
  permalink: null,
  mediaType: null,
  ...over,
});

describe('classifyFormat', () => {
  it('calls every YouTube and TikTok post a video', () => {
    const imported = post({
      imported: true,
      mediaItems: [{ url: 'u', type: 'image' }],
    });
    expect(classifyFormat(imported, 'youtube')).toBe('video');
    expect(classifyFormat(imported, 'tiktok')).toBe('video');
  });

  it.each([
    ['IMAGE', 'image'],
    ['photo', 'image'],
    ['VIDEO', 'video'],
    ['REELS', 'video'],
    ['video', 'video'],
    ['animated_gif', 'video'],
    ['CAROUSEL_ALBUM', 'carousel'],
    ['TEXT', 'text'],
    ['TEXT_POST', 'text'],
  ])(
    'trusts the media type the platform reported (%s → %s)',
    (mediaType, format) => {
      expect(
        classifyFormat(post({ mediaType, imported: true }), 'instagram'),
      ).toBe(format);
    },
  );

  it('reads a Schedura post from its own media', () => {
    const img = { url: 'u', type: 'image' };
    expect(classifyFormat(post({}), 'linkedin')).toBe('text');
    expect(classifyFormat(post({ mediaItems: [img] }), 'linkedin')).toBe(
      'image',
    );
    expect(
      classifyFormat(
        post({ mediaItems: [{ url: 'u', type: 'gif' }] }),
        'linkedin',
      ),
    ).toBe('image');
    expect(
      classifyFormat(
        post({ mediaItems: [{ url: 'u', type: 'video' }] }),
        'linkedin',
      ),
    ).toBe('video');
    expect(classifyFormat(post({ mediaItems: [img, img] }), 'linkedin')).toBe(
      'carousel',
    );
    expect(
      classifyFormat(
        post({ mediaItems: [{ url: 'u', type: 'carousel' }] }),
        'linkedin',
      ),
    ).toBe('carousel');
  });

  it("won't guess for an imported post: its media is always stored as image", () => {
    expect(
      classifyFormat(
        post({ imported: true, mediaItems: [{ url: 'u', type: 'image' }] }),
        'facebook',
      ),
    ).toBe('unknown');
  });

  it('ignores a media type it does not know, including prototype keys', () => {
    expect(
      classifyFormat(
        post({ mediaType: 'constructor', imported: true }),
        'instagram',
      ),
    ).toBe('unknown');
    expect(classifyFormat(post({ mediaType: 'HOLOGRAM' }), 'instagram')).toBe(
      'text',
    );
  });

  it('classifies no media plus a URL as link', () => {
    expect(
      classifyFormat(
        post({ content: 'see https://a.co', mediaItems: [] }),
        'facebook',
      ),
    ).toBe('link');
    expect(
      classifyFormat(post({ content: 'read http://a.co/x?y=1' }), 'linkedin'),
    ).toBe('link');
  });

  it('a link post beats what the platform reported, and an import', () => {
    expect(
      classifyFormat(
        post({
          content: 'new blog https://a.co',
          mediaType: 'TEXT_POST',
          imported: true,
        }),
        'threads',
      ),
    ).toBe('link');
  });

  it('keeps video platforms as video, whatever the caption', () => {
    const linky = post({ content: 'watch https://a.co', mediaItems: [] });
    expect(classifyFormat(linky, 'youtube')).toBe('video');
    expect(classifyFormat(linky, 'tiktok')).toBe('video');
  });

  it('a caption with a URL and media keeps the media format', () => {
    const img = { url: 'u', type: 'image' };
    expect(
      classifyFormat(
        post({ content: 'see https://a.co', mediaItems: [img] }),
        'facebook',
      ),
    ).toBe('image');
    expect(
      classifyFormat(
        post({ content: 'see https://a.co', mediaItems: [img, img] }),
        'linkedin',
      ),
    ).toBe('carousel');
  });

  it('a caption without a full URL stays text', () => {
    expect(
      classifyFormat(post({ content: 'visit a.co or https://' }), 'facebook'),
    ).toBe('text');
  });

  it('lists link after carousel', () => {
    expect(POST_FORMATS).toEqual([
      'image',
      'video',
      'carousel',
      'link',
      'text',
    ]);
  });
});

describe('firstLine', () => {
  it('title is the caption first line', () =>
    expect(firstLine('Meet Ali\nmore')).toBe('Meet Ali'));

  it('skips blank lines, trims, and copes with CRLF', () => {
    expect(firstLine('\n  \r\n  Launch day  \r\nmore')).toBe('Launch day');
  });

  it('is empty for an empty or blank caption', () => {
    expect(firstLine('')).toBe('');
    expect(firstLine(' \n\t\n')).toBe('');
  });

  it('cuts a long line to max characters, ellipsis included, never splitting an emoji', () => {
    const line = `${'a'.repeat(118)}👋👋 tail`;
    const t = firstLine(line);
    expect(t).toBe(`${'a'.repeat(118)}👋…`);
    expect(Array.from(t)).toHaveLength(120);
    expect(firstLine('abcdef', 4)).toBe('abc…');
    expect(firstLine('abcd', 4)).toBe('abcd');
  });
});

describe('isSettling', () => {
  const at = (hoursAgo: number) =>
    post({
      publishedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
    });

  it('is true under 2 days old and false from 2 days on', () => {
    expect(isSettling(at(1), NOW)).toBe(true);
    expect(isSettling(at(47.9), NOW)).toBe(true);
    expect(isSettling(at(48), NOW)).toBe(false);
    expect(isSettling(at(100), NOW)).toBe(false);
  });
});

describe('toInsightPost', () => {
  it('adds engagements, the rate and a thumbnail', () => {
    const p = toInsightPost(
      post({
        likes: 40,
        comments: 8,
        shares: 2,
        impressions: 1000,
        content: 'Caption',
        permalink: 'https://x/p',
        mediaItems: [
          {
            url: 'https://x/v.mp4',
            type: 'video',
            thumbnailUrl: 'https://x/v.jpg',
          },
        ],
      }),
      'instagram',
      { now: NOW },
    );
    expect(p).toMatchObject({
      engagements: 50,
      engagementRate: 5,
      thumbnailUrl: 'https://x/v.jpg',
      format: 'video',
      content: 'Caption',
      permalink: 'https://x/p',
    });
  });

  it('uses the media url when there is no thumbnail, and null without media', () => {
    expect(
      toInsightPost(
        post({ mediaItems: [{ url: 'https://x/a.jpg', type: 'image' }] }),
        'x',
        { now: NOW },
      ).thumbnailUrl,
    ).toBe('https://x/a.jpg');
    expect(toInsightPost(post({}), 'x', { now: NOW }).thumbnailUrl).toBeNull();
  });

  it('trims the caption to 280 characters without splitting an emoji', () => {
    const caption = `${'a'.repeat(279)}👋 and more`;
    expect(
      toInsightPost(post({ content: caption }), 'x', { now: NOW }).content,
    ).toBe(`${'a'.repeat(279)}👋`);
  });

  it('keeps the whole caption when asked to', () => {
    const caption = 'b'.repeat(1500);
    expect(
      toInsightPost(post({ content: caption }), 'x', {
        captionChars: null,
        now: NOW,
      }).content,
    ).toBe(caption);
  });

  it('has no rate without impressions, or with zero impressions', () => {
    expect(
      toInsightPost(post({ likes: 5 }), 'bluesky', { now: NOW }).engagementRate,
    ).toBeNull();
    expect(
      toInsightPost(post({ likes: 5, impressions: 0 }), 'x', { now: NOW })
        .engagementRate,
    ).toBeNull();
  });

  it('carries the title, reach, the import flag and settling', () => {
    const p = toInsightPost(
      post({
        content: 'Meet Ali\nOur new designer',
        reach: 640,
        imported: true,
        publishedAt: '2026-09-22T00:00:00.000Z',
      }),
      'instagram',
      { now: NOW },
    );
    expect(p).toMatchObject({
      title: 'Meet Ali',
      content: 'Meet Ali\nOur new designer',
      reach: 640,
      imported: true,
      isSettling: true,
      usualMultiplier: null,
    });
    expect(
      toInsightPost(post({ publishedAt: '2026-09-10T00:00:00.000Z' }), 'x', {
        now: NOW,
      }).isSettling,
    ).toBe(false);
  });

  it('measures the multiplier against the usual it is given', () => {
    const usual = new Map([[1, [4, 5, 5, 5, 6]]]);
    expect(
      toInsightPost(post({ likes: 10 }), 'x', { usual, now: NOW })
        .usualMultiplier,
    ).toBe(2);
    // Not measured is not "0x the usual".
    expect(
      toInsightPost(post({}), 'x', { usual, now: NOW }).usualMultiplier,
    ).toBeNull();
  });
});
