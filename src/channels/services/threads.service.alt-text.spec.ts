/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await -- test doubles are loosely typed */

import { ThreadsService } from './threads.service';

/**
 * S5: `alt_text` on the container body - "(For images and videos only.)
 * The accessibility text label or description for an image or video"
 * (Threads posts reference / accessibility page). Never on a text post.
 */
describe('ThreadsService — alt_text on the container body', () => {
  let service: ThreadsService;
  let fetchMock: jest.Mock;
  const realFetch = global.fetch;

  beforeEach(() => {
    service = new ThreadsService();
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'container-or-post' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  const bodyOf = (n: number) =>
    JSON.parse(fetchMock.mock.calls[n][1].body as string);

  it('sends an image its alt text, trimmed', async () => {
    await service.createImageThread(
      'token',
      'user',
      'https://cdn.test/a.jpg',
      'hi',
      undefined,
      { altText: '  A flat white  ', replyControl: 'everyone' },
    );
    expect(bodyOf(0).alt_text).toBe('A flat white');
    expect(bodyOf(0).reply_control).toBe('everyone');
  });

  it('omits it when there is none', async () => {
    await service.createImageThread('token', 'user', 'https://cdn.test/a.jpg');
    expect('alt_text' in bodyOf(0)).toBe(false);
  });

  it('sends each carousel item its own, never the parent', async () => {
    await service.createCarouselThread(
      'token',
      'user',
      [
        { type: 'IMAGE', url: 'https://cdn.test/1.jpg', altText: 'One' },
        { type: 'IMAGE', url: 'https://cdn.test/2.jpg' },
      ],
      'hi',
    );
    expect(bodyOf(0).alt_text).toBe('One');
    expect('alt_text' in bodyOf(1)).toBe(false);
    expect(bodyOf(2).media_type).toBe('CAROUSEL');
    expect('alt_text' in bodyOf(2)).toBe(false);
  });
});
