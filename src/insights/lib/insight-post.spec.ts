import type { PublishedPost } from '../../post-performance/post-performance';
import { classifyFormat, toInsightPost } from './insight-post';

const post = (over: Partial<PublishedPost>): PublishedPost => ({
  postId: 'p1',
  channelId: 1,
  publishedOn: '2026-09-20',
  likes: null,
  comments: null,
  shares: null,
  impressions: null,
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
      ).thumbnailUrl,
    ).toBe('https://x/a.jpg');
    expect(toInsightPost(post({}), 'x').thumbnailUrl).toBeNull();
  });

  it('trims the caption to 280 characters without splitting an emoji', () => {
    const caption = `${'a'.repeat(279)}👋 and more`;
    expect(toInsightPost(post({ content: caption }), 'x').content).toBe(
      `${'a'.repeat(279)}👋`,
    );
  });

  it('keeps the whole caption when asked to', () => {
    const caption = 'b'.repeat(1500);
    expect(toInsightPost(post({ content: caption }), 'x', null).content).toBe(
      caption,
    );
  });

  it('has no rate without impressions, or with zero impressions', () => {
    expect(
      toInsightPost(post({ likes: 5 }), 'bluesky').engagementRate,
    ).toBeNull();
    expect(
      toInsightPost(post({ likes: 5, impressions: 0 }), 'x').engagementRate,
    ).toBeNull();
  });
});
