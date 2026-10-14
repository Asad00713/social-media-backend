/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await -- test doubles are loosely typed */
import { FirstWeekStockImageService } from './first-week-stock-image.service';

const unsplashPhoto = {
  width: 1080,
  height: 1080,
  altDescription: 'beans',
  description: null,
  urls: {
    regular: 'https://images.unsplash.com/regular',
    small: 'https://images.unsplash.com/small',
  },
  links: {
    html: 'https://unsplash.com/photos/1',
    downloadLocation: 'https://api.unsplash.com/photos/1/download',
  },
  user: { name: 'Ana' },
};
const pexelsPhoto = {
  width: 800,
  height: 800,
  alt: 'cup',
  url: 'https://www.pexels.com/photo/1',
  photographer: 'Raj',
  src: { large: 'https://images.pexels.com/large' },
};

function make(over: { unsplash?: any; pexels?: any } = {}) {
  const unsplash = {
    searchPhotos: jest.fn(async () => ({
      total: 1,
      totalPages: 1,
      results: [unsplashPhoto],
    })),
    trackDownload: jest.fn(async () => undefined),
    ...over.unsplash,
  };
  const pexels = {
    searchPhotos: jest.fn(async () => ({ items: [pexelsPhoto] })),
    ...over.pexels,
  };
  return {
    svc: new FirstWeekStockImageService(unsplash, pexels),
    unsplash,
    pexels,
  };
}

describe('FirstWeekStockImageService', () => {
  it('uses Unsplash first and reports its download', async () => {
    const { svc, unsplash, pexels } = make();
    const img = await svc.find('coffee beans');
    expect(img).toEqual({
      url: 'https://images.unsplash.com/regular',
      width: 1080,
      height: 1080,
      alt: 'beans',
      credit: {
        provider: 'unsplash',
        author: 'Ana',
        pageUrl: 'https://unsplash.com/photos/1',
      },
    });
    expect(unsplash.searchPhotos).toHaveBeenCalledWith(
      'coffee beans',
      1,
      1,
      'squarish',
    );
    expect(unsplash.trackDownload).toHaveBeenCalledWith(
      'https://api.unsplash.com/photos/1/download',
    );
    expect(pexels.searchPhotos).not.toHaveBeenCalled();
  });

  it('falls back to Pexels when Unsplash has no result', async () => {
    const { svc } = make({
      unsplash: {
        searchPhotos: jest.fn(async () => ({
          total: 0,
          totalPages: 0,
          results: [],
        })),
      },
    });
    const img = await svc.find('x');
    expect(img?.credit.provider).toBe('pexels');
    expect(img?.url).toBe('https://images.pexels.com/large');
  });

  it('falls back to Pexels when Unsplash throws (key missing, rate limit)', async () => {
    const { svc } = make({
      unsplash: {
        searchPhotos: jest.fn(async () => {
          throw new Error('Unsplash API not configured');
        }),
      },
    });
    expect((await svc.find('x'))?.credit.provider).toBe('pexels');
  });

  it('returns null when both providers fail or find nothing', async () => {
    const { svc } = make({
      unsplash: {
        searchPhotos: jest.fn(async () => {
          throw new Error('nope');
        }),
      },
      pexels: { searchPhotos: jest.fn(async () => ({ items: [] })) },
    });
    expect(await svc.find('x')).toBeNull();
  });

  it('never rejects, even when both throw', async () => {
    const { svc } = make({
      unsplash: {
        searchPhotos: jest.fn(async () => {
          throw new Error('a');
        }),
      },
      pexels: {
        searchPhotos: jest.fn(async () => {
          throw new Error('b');
        }),
      },
    });
    await expect(svc.find('x')).resolves.toBeNull();
  });

  it('does not call either provider for a blank query', async () => {
    const { svc, unsplash, pexels } = make();
    expect(await svc.find('   ')).toBeNull();
    expect(unsplash.searchPhotos).not.toHaveBeenCalled();
    expect(pexels.searchPhotos).not.toHaveBeenCalled();
  });

  it('ignores a non-https result', async () => {
    const { svc } = make({
      unsplash: {
        searchPhotos: jest.fn(async () => ({
          total: 1,
          totalPages: 1,
          results: [
            {
              ...unsplashPhoto,
              urls: {
                regular: 'http://insecure/x.jpg',
                small: 'http://insecure/y.jpg',
              },
            },
          ],
        })),
      },
    });
    expect((await svc.find('x'))?.credit.provider).toBe('pexels');
  });
});
