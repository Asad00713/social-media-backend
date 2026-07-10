import { BadRequestException } from '@nestjs/common';
import { StockMediaService } from './stock-media.service';

function makeService(overrides: {
  unsplash?: Partial<Record<string, jest.Mock>>;
  pexels?: Partial<Record<string, jest.Mock>>;
} = {}) {
  const unsplash = {
    searchPhotos: jest.fn(),
    trackDownload: jest.fn().mockResolvedValue(undefined),
    ...overrides.unsplash,
  };
  const pexels = {
    searchPhotos: jest.fn(),
    searchVideos: jest.fn(),
    ...overrides.pexels,
  };
  const service = new StockMediaService(unsplash as any, pexels as any);
  return { service, unsplash, pexels };
}

const unsplashResult = {
  total: 100,
  totalPages: 5,
  results: [
    {
      id: 'a1', width: 10, height: 10, color: '', blurHash: '', description: null, altDescription: null,
      urls: { raw: 'r', full: 'f', regular: 'reg', small: 'sm', thumb: 'th' },
      links: { self: 's', html: 'https://unsplash.com/photos/a1', download: 'd', downloadLocation: 'https://api.unsplash.com/photos/a1/download' },
      user: { id: 'u', username: 'x', name: 'X', profileUrl: 'https://unsplash.com/@x', profileImage: '' },
    },
  ],
};

describe('StockMediaService.search', () => {
  it('rejects unsplash + video', async () => {
    const { service } = makeService();
    await expect(
      service.search({ provider: 'unsplash', type: 'video', q: 'cats', page: 1, perPage: 24 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps unsplash images and derives hasMore from totalPages', async () => {
    const { service, unsplash } = makeService({
      unsplash: { searchPhotos: jest.fn().mockResolvedValue(unsplashResult) },
    });
    const res = await service.search({ provider: 'unsplash', type: 'image', q: 'cats', page: 1, perPage: 24 });
    expect(unsplash.searchPhotos).toHaveBeenCalledWith('cats', 1, 24);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].provider).toBe('unsplash');
    expect(res.hasMore).toBe(true); // page 1 < totalPages 5
  });

  it('derives hasMore=false on the last unsplash page', async () => {
    const { service } = makeService({
      unsplash: { searchPhotos: jest.fn().mockResolvedValue({ ...unsplashResult, totalPages: 1 }) },
    });
    const res = await service.search({ provider: 'unsplash', type: 'image', q: 'cats', page: 1, perPage: 24 });
    expect(res.hasMore).toBe(false);
  });

  it('maps pexels photos and derives hasMore from nextPage', async () => {
    const { service, pexels } = makeService({
      pexels: {
        searchPhotos: jest.fn().mockResolvedValue({
          items: [{ id: 1, width: 1, height: 1, url: 'u', photographer: 'P', photographerUrl: 'pu', photographerId: 1, avgColor: '', src: { original: 'o', large2x: 'l2', large: 'l', medium: 'm', small: 's', portrait: 'p', landscape: 'ld', tiny: 't' }, alt: '' }],
          totalResults: 30, page: 1, perPage: 24, nextPage: 'https://api.pexels.com/next', prevPage: null,
        }),
      },
    });
    const res = await service.search({ provider: 'pexels', type: 'image', q: 'cats', page: 1, perPage: 24 });
    expect(pexels.searchPhotos).toHaveBeenCalledWith({ query: 'cats', page: 1, perPage: 24 });
    expect(res.items[0].provider).toBe('pexels');
    expect(res.hasMore).toBe(true);
  });

  it('maps pexels videos', async () => {
    const { service, pexels } = makeService({
      pexels: {
        searchVideos: jest.fn().mockResolvedValue({
          items: [{ id: 2, width: 2, height: 2, url: 'vu', image: 'img', duration: 5, user: { id: 1, name: 'V', url: 'vurl' }, videoFiles: [{ id: 1, quality: 'hd', fileType: 'video/mp4', width: 2, height: 2, fps: 30, link: 'link.mp4' }], videoPictures: [] }],
          totalResults: 5, page: 1, perPage: 24, nextPage: null, prevPage: null,
        }),
      },
    });
    const res = await service.search({ provider: 'pexels', type: 'video', q: 'cats', page: 1, perPage: 24 });
    expect(pexels.searchVideos).toHaveBeenCalledWith({ query: 'cats', page: 1, perPage: 24 });
    expect(res.items[0].type).toBe('video');
    expect(res.hasMore).toBe(false);
  });
});

describe('StockMediaService.track', () => {
  it('delegates unsplash download-location hosts to the unsplash service', async () => {
    const { service, unsplash } = makeService();
    await service.track('https://api.unsplash.com/photos/a1/download?ixid=1');
    expect(unsplash.trackDownload).toHaveBeenCalledWith('https://api.unsplash.com/photos/a1/download?ixid=1');
  });

  it('ignores non-unsplash hosts (fail-closed, no throw)', async () => {
    const { service, unsplash } = makeService();
    await service.track('https://evil.example.com/track');
    expect(unsplash.trackDownload).not.toHaveBeenCalled();
  });

  it('ignores malformed urls without throwing', async () => {
    const { service, unsplash } = makeService();
    await service.track('not a url');
    expect(unsplash.trackDownload).not.toHaveBeenCalled();
  });
});
