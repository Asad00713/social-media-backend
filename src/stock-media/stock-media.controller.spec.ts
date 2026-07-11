import { StockMediaController } from './stock-media.controller';

describe('StockMediaController', () => {
  const service = {
    search: jest.fn(),
    track: jest.fn().mockResolvedValue(undefined),
  };
  const controller = new StockMediaController(service as any);

  afterEach(() => jest.clearAllMocks());

  it('passes search params through with defaults applied', async () => {
    service.search.mockResolvedValue({ items: [], page: 1, hasMore: false });
    await controller.search({
      provider: 'unsplash',
      type: 'image',
      q: 'cats',
    } as any);
    expect(service.search).toHaveBeenCalledWith({
      provider: 'unsplash',
      type: 'image',
      q: 'cats',
      page: 1,
      perPage: 24,
    });
  });

  it('honours explicit page/perPage', async () => {
    service.search.mockResolvedValue({ items: [], page: 3, hasMore: true });
    await controller.search({
      provider: 'pexels',
      type: 'video',
      q: 'sea',
      page: 3,
      perPage: 40,
    } as any);
    expect(service.search).toHaveBeenCalledWith({
      provider: 'pexels',
      type: 'video',
      q: 'sea',
      page: 3,
      perPage: 40,
    });
  });

  it('delegates track to the service', async () => {
    await controller.track({
      downloadTriggerUrl: 'https://api.unsplash.com/x/download',
    } as any);
    expect(service.track).toHaveBeenCalledWith(
      'https://api.unsplash.com/x/download',
    );
  });
});
