/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await -- test doubles are loosely typed */

import { InstagramService } from './instagram.service';

/** S5: the `alt_text` parameter's name and placement on the real form body. */
describe('InstagramService — alt_text on the container', () => {
  let service: InstagramService;
  let fetchMock: jest.Mock;
  const realFetch = global.fetch;

  beforeEach(() => {
    service = new InstagramService();
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'container-1', status_code: 'FINISHED' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    // The carousel's aspect-ratio check downloads images; not under test.
    jest
      .spyOn(service as any, 'validateCarouselAspectRatios')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  const containerForms = () =>
    fetchMock.mock.calls
      .filter(
        ([url, init]) =>
          String(url).endsWith('/media') && init?.method === 'POST',
      )
      .map(([, init]) => new URLSearchParams(init.body.toString()));

  it('sends alt_text on a single image container', async () => {
    await service.createImagePostWithUserToken(
      'user',
      'token',
      'https://example.test/a.jpg',
      'caption',
      { altText: '  A flat white  ' },
    );
    expect(containerForms()[0].get('alt_text')).toBe('A flat white');
  });

  it('sends it on each image item of a carousel, never on the parent', async () => {
    await service.createCarouselPostWithUserToken(
      'user',
      'token',
      [
        { type: 'IMAGE', url: 'https://example.test/1.jpg', altText: 'One' },
        { type: 'IMAGE', url: 'https://example.test/2.jpg' },
      ],
      'caption',
      {},
    );
    const [first, second, parent] = containerForms();
    expect(first.get('alt_text')).toBe('One');
    expect(second.has('alt_text')).toBe(false);
    expect(parent.get('media_type')).toBe('CAROUSEL');
    expect(parent.has('alt_text')).toBe(false);
  });
});
