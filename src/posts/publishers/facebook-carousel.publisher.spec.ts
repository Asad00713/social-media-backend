import { FacebookPublisher } from './facebook.publisher';
import { FacebookService } from '../../channels/services/facebook.service';
import { PublishOptions } from './base.publisher';
import {
  FACEBOOK_CAROUSEL_MAX,
  FACEBOOK_CAROUSEL_MIN,
  carouselErrors,
  wantsCarousel,
} from './facebook-carousel';
import {
  extractPageMeta,
  fetchPublicHtml,
} from '../../media-library/lib/link-meta';

// A card without an image has its page read - through the SSRF-safe helpers
// only. Mocked here so the test proves that path is the one taken.
jest.mock('../../media-library/lib/link-meta', () => ({
  fetchPublicHtml: jest.fn(),
  extractPageMeta: jest.fn(),
}));
const mockFetchHtml = fetchPublicHtml as jest.MockedFunction<
  typeof fetchPublicHtml
>;
const mockExtract = extractPageMeta as jest.MockedFunction<
  typeof extractPageMeta
>;

const A = {
  url: 'https://lumiere.pk/menu',
  title: 'Autumn menu',
  description: 'From Rs 450',
  imageUrl: 'https://cdn.lumiere.pk/menu.jpg',
};
const B = {
  url: 'https://lumiere.pk/bakes',
  title: 'Bakes',
  imageUrl: 'https://cdn.lumiere.pk/bakes.jpg',
};

describe('FacebookPublisher - link carousel', () => {
  let publisher: FacebookPublisher;
  let service: jest.Mocked<
    Pick<
      FacebookService,
      'postCarouselToPage' | 'postToPage' | 'postPhotoToPage'
    >
  >;

  const caption = `Autumn is here ${A.url}`;
  const options = (
    metadata: Record<string, unknown>,
    over: Partial<PublishOptions> = {},
  ): PublishOptions =>
    ({
      content: caption,
      mediaItems: [],
      accessToken: 'page-token',
      metadata: { postType: 'post', ...metadata },
      channelMetadata: {},
      platformAccountId: 'page-1',
      channelId: 1,
      ...over,
    }) as PublishOptions;

  beforeEach(() => {
    mockFetchHtml.mockReset();
    mockExtract.mockReset();
    service = {
      postCarouselToPage: jest.fn().mockResolvedValue({ postId: 'car-1' }),
      postToPage: jest.fn().mockResolvedValue({ postId: 'post-1' }),
      postPhotoToPage: jest.fn().mockResolvedValue({ postId: 'photo-1' }),
    } as any;
    publisher = new FacebookPublisher(service as unknown as FacebookService);
  });

  it('sends the cards, in order, with the caption and its link', async () => {
    const result = await publisher.publish(
      options({ carouselLinks: [A, B], linkCta: 'learn' }),
    );
    expect(service.postToPage).not.toHaveBeenCalled();
    expect(service.postCarouselToPage).toHaveBeenCalledWith(
      'page-1',
      'page-token',
      caption,
      A.url,
      [
        {
          link: A.url,
          picture: A.imageUrl,
          name: A.title,
          description: A.description,
        },
        { link: B.url, picture: B.imageUrl, name: B.title },
      ],
      {},
    );
    expect(result.platformPostId).toBe('car-1');
    // Every card had an image: no page was read.
    expect(mockFetchHtml).not.toHaveBeenCalled();
  });

  it('falls back to the first card as the post link when the caption has none', async () => {
    await publisher.publish(
      options({ carouselLinks: [B, A] }, { content: 'no link here' }),
    );
    expect(service.postCarouselToPage.mock.calls[0][3]).toBe(B.url);
  });

  it('reads og:image (and the title) through the safe helpers for a card without an image', async () => {
    mockFetchHtml.mockResolvedValue({
      html: '<head>',
      finalUrl: 'https://lumiere.pk/bakes',
    });
    mockExtract.mockReturnValue({
      title: 'Bakes at Lumiere',
      imageUrl: '/og/bakes.jpg',
      faviconUrl: 'https://lumiere.pk/favicon.ico',
    });

    await publisher.publish(options({ carouselLinks: [A, { url: B.url }] }));

    expect(mockFetchHtml).toHaveBeenCalledTimes(1);
    expect(mockFetchHtml.mock.calls[0][0]).toBe(B.url);
    const cards = service.postCarouselToPage.mock.calls[0][4];
    expect(cards[1]).toEqual({
      link: B.url,
      picture: 'https://lumiere.pk/og/bakes.jpg',
      name: 'Bakes at Lumiere',
    });
  });

  it('keeps the draft title over the scraped one', async () => {
    mockFetchHtml.mockResolvedValue({ html: '', finalUrl: B.url });
    mockExtract.mockReturnValue({
      title: 'Scraped',
      imageUrl: 'https://cdn.example/i.jpg',
      faviconUrl: '',
    });
    await publisher.publish(
      options({ carouselLinks: [A, { url: B.url, title: 'Mine' }] }),
    );
    expect(service.postCarouselToPage.mock.calls[0][4][1].name).toBe('Mine');
  });

  it('fails the post, naming the card, when no image can be found', async () => {
    mockFetchHtml.mockResolvedValue(null);
    await expect(
      publisher.publish(options({ carouselLinks: [A, { url: B.url }] })),
    ).rejects.toThrow(/card 2 \(lumiere\.pk\) has no image/);
    expect(service.postCarouselToPage).not.toHaveBeenCalled();
  });

  it('is a plain link post when the list is empty', async () => {
    await publisher.publish(options({ carouselLinks: [] }));
    expect(service.postCarouselToPage).not.toHaveBeenCalled();
    expect(service.postToPage).toHaveBeenCalled();
  });

  it('is left unsent on a photo post, and not validated there', async () => {
    await publisher.publish(
      options(
        { carouselLinks: [A] },
        {
          mediaItems: [
            { type: 'image', url: 'https://cdn.example/p.jpg' } as any,
          ],
        },
      ),
    );
    expect(service.postCarouselToPage).not.toHaveBeenCalled();
    expect(service.postPhotoToPage).toHaveBeenCalled();
  });

  describe('validate', () => {
    const check = (carouselLinks: unknown) => () =>
      publisher.validate(options({ carouselLinks }));

    it('takes 2 to 5 links', () => {
      expect(FACEBOOK_CAROUSEL_MIN).toBe(2);
      expect(FACEBOOK_CAROUSEL_MAX).toBe(5);
      expect(check([A, B])).not.toThrow();
      expect(check([A, B, A, B, A])).not.toThrow();
    });

    it('refuses one link, and six', () => {
      expect(check([A])).toThrow(/2 to 5 links; this one has 1/);
      expect(check([A, B, A, B, A, B])).toThrow(/this one has 6/);
    });

    it('refuses a link or an image that is not https', () => {
      expect(check([A, { url: 'http://lumiere.pk/x' }])).toThrow(
        /Carousel link 2 must be an https:\/\/ URL/,
      );
      expect(check([A, { url: 'not a url' }])).toThrow(/link 2/);
      expect(
        check([{ ...A, imageUrl: 'http://cdn.example/i.jpg' }, B]),
      ).toThrow(/link 1's image/);
    });

    it('refuses a value that is not a list', () => {
      expect(check({ url: A.url })).toThrow(/must be a list/);
    });

    it('runs from publish, before anything is sent', async () => {
      await expect(
        publisher.publish(options({ carouselLinks: [A] })),
      ).rejects.toThrow(/2 to 5/);
      expect(service.postCarouselToPage).not.toHaveBeenCalled();
    });
  });

  describe('wantsCarousel', () => {
    it('only on a Post with no media and a non-empty key', () => {
      expect(wantsCarousel({ carouselLinks: [A] }, 0)).toBe(true);
      expect(wantsCarousel({ postType: 'post', carouselLinks: 'x' }, 0)).toBe(
        true,
      );
      expect(wantsCarousel({ carouselLinks: [] }, 0)).toBe(false);
      expect(wantsCarousel({}, 0)).toBe(false);
      expect(wantsCarousel({ carouselLinks: [A] }, 1)).toBe(false);
      expect(wantsCarousel({ postType: 'reel', carouselLinks: [A] }, 0)).toBe(
        false,
      );
      expect(wantsCarousel({ postType: 'story', carouselLinks: [A] }, 0)).toBe(
        false,
      );
    });
  });

  it('lists every problem at once', () => {
    expect(
      carouselErrors({ carouselLinks: [{ url: 'http://a' }] }),
    ).toHaveLength(2);
  });
});
