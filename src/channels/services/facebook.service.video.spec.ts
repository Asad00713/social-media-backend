/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */

import { FacebookService } from './facebook.service';

// The network is stubbed with `global.fetch`. The thumbnail download must go
// through the SSRF-guarded fetchPublicMedia, so it is a recorded mock that
// routes back to the stub: a raw `fetch` of the picture would bypass it and
// fail the "goes through the guard" test below.
const mockFetchPublicMedia = jest.fn((url: string) => global.fetch(url));
jest.mock('../../common/net/public-fetch', () => ({
  ...jest.requireActual<typeof import('../../common/net/public-fetch')>(
    '../../common/net/public-fetch',
  ),
  fetchPublicMedia: (url: string, init?: unknown) =>
    mockFetchPublicMedia(url, init as never),
}));

/**
 * A Facebook feed video is `POST /{page-id}/videos`, multipart, with the
 * video as `file_url` and YouTube's designed thumbnail as `thumb` - a FILE
 * (Meta: "The video thumbnail raw data to be uploaded"). These pin the
 * request, and that the thumbnail never costs the post.
 */
describe('FacebookService.postVideoToPage', () => {
  let service: FacebookService;
  let fetchMock: jest.Mock;
  let thumbStatus: number;
  let thumbType: string | null;
  let videoResponses: { status: number; body: unknown }[];

  const THUMB = 'https://cdn.example/thumb.png';
  const VIDEO = 'https://cdn.example/v.mp4';

  const videoCalls = () =>
    fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/page-1/videos'));
  const formOf = (i: number) => videoCalls()[i][1].body as FormData;

  beforeEach(() => {
    thumbStatus = 200;
    thumbType = 'image/png';
    videoResponses = [{ status: 200, body: { id: 'vid-1' } }];
    mockFetchPublicMedia.mockClear();
    service = new FacebookService();
    fetchMock = jest.fn().mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url === THUMB) {
        return {
          ok: thumbStatus === 200,
          status: thumbStatus,
          headers: { get: () => thumbType },
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
        };
      }
      const next = videoResponses.shift() ?? {
        status: 200,
        body: { id: 'vid-1' },
      };
      return {
        ok: next.status < 400,
        status: next.status,
        json: async () => next.body,
      };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const post = (options?: { thumbnailUrl?: string }) =>
    service.postVideoToPage(
      'page-1',
      'page-token',
      VIDEO,
      'a caption',
      options,
    );

  it('posts the video to the Page’s /videos edge as multipart', async () => {
    const result = await post();
    expect(result).toEqual({ postId: 'vid-1' });
    const [call] = videoCalls();
    expect(String(call[0])).toMatch(
      /graph\.facebook\.com\/v[\d.]+\/page-1\/videos$/,
    );
    expect(call[1].method).toBe('POST');
    const form = formOf(0);
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('access_token')).toBe('page-token');
    expect(form.get('file_url')).toBe(VIDEO);
    expect(form.get('description')).toBe('a caption');
    expect(form.get('thumb')).toBeNull();
  });

  it('sends the thumbnail as the `thumb` FILE in the same request', async () => {
    const result = await post({ thumbnailUrl: THUMB });
    expect(result).toEqual({ postId: 'vid-1' });
    expect(videoCalls()).toHaveLength(1);
    const thumb = formOf(0).get('thumb') as File;
    expect(thumb).toBeInstanceOf(Blob);
    expect(thumb.type).toBe('image/png');
    expect(thumb.size).toBe(4);
    expect(thumb.name).toBe('thumbnail.png');
  });

  it('downloads the thumbnail through the SSRF guard, capped', async () => {
    await post({ thumbnailUrl: THUMB });
    expect(mockFetchPublicMedia).toHaveBeenCalledWith(
      THUMB,
      expect.objectContaining({ maxBytes: 10 * 1024 * 1024 }),
    );
  });

  it('posts the video without it when the picture cannot be downloaded', async () => {
    thumbStatus = 404;
    const result = await post({ thumbnailUrl: THUMB });
    expect(result.postId).toBe('vid-1');
    expect(result.thumbnailWarning).toMatch(/HTTP 404/);
    expect(videoCalls()).toHaveLength(1);
    expect(formOf(0).get('thumb')).toBeNull();
  });

  it('posts the video without it when the address is not an image', async () => {
    thumbType = 'text/html; charset=utf-8';
    const result = await post({ thumbnailUrl: THUMB });
    expect(result.thumbnailWarning).toMatch(/not an image/);
    expect(formOf(0).get('thumb')).toBeNull();
  });

  it('refuses a non-web thumbnail address without fetching it', async () => {
    const result = await post({ thumbnailUrl: 'file:///etc/passwd' });
    expect(mockFetchPublicMedia).not.toHaveBeenCalled();
    expect(result.thumbnailWarning).toMatch(/web/);
    expect(formOf(0).get('thumb')).toBeNull();
  });

  it('retries once without the picture when Facebook refuses the request', async () => {
    videoResponses = [
      { status: 400, body: { error: { message: 'Invalid image' } } },
      { status: 200, body: { id: 'vid-2' } },
    ];
    const result = await post({ thumbnailUrl: THUMB });
    expect(result.postId).toBe('vid-2');
    expect(result.thumbnailWarning).toMatch(/Invalid image/);
    expect(videoCalls()).toHaveLength(2);
    expect(formOf(0).get('thumb')).not.toBeNull();
    expect(formOf(1).get('thumb')).toBeNull();
  });

  it('does not retry a server error, which may have created the video', async () => {
    videoResponses = [{ status: 500, body: { error: { message: 'boom' } } }];
    await expect(post({ thumbnailUrl: THUMB })).rejects.toThrow(/boom/);
    expect(videoCalls()).toHaveLength(1);
  });

  it('fails the post when the video itself is refused', async () => {
    videoResponses = [
      { status: 400, body: { error: { message: 'Bad video' } } },
    ];
    await expect(post()).rejects.toThrow(/Bad video/);
    expect(videoCalls()).toHaveLength(1);
  });
});
