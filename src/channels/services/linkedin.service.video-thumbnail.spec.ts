/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */

import { LinkedInService } from './linkedin.service';

// The network is stubbed with `global.fetch`. Downloads must go through the
// SSRF-guarded fetchPublicMedia, so it is a recorded mock routing back to the
// stub: a raw `fetch` of the thumbnail would bypass it and fail the "goes
// through the guard" test below.
const mockFetchPublicMedia = jest.fn((url: string) => global.fetch(url));
jest.mock('../../common/net/public-fetch', () => ({
  ...jest.requireActual<typeof import('../../common/net/public-fetch')>(
    '../../common/net/public-fetch',
  ),
  fetchPublicMedia: (url: string, init?: unknown) =>
    mockFetchPublicMedia(url, init as never),
}));

/**
 * A LinkedIn video's thumbnail rides the Videos API: `uploadThumbnail: true`
 * on initializeUpload, then a PUT of the image to the `thumbnailUploadUrl` it
 * returns (`media-type-family: STILLIMAGE`, octet-stream). These pin those
 * requests, their order, and that a thumbnail never costs the post.
 */
describe('LinkedInService.createRestVideoPost - the thumbnail', () => {
  let service: LinkedInService;
  let fetchMock: jest.Mock;
  let thumbStatus: number;
  let thumbPutStatus: number;
  let returnsThumbnailUrl: boolean;

  const THUMB = 'https://cdn.test/thumb.jpg';
  const THUMB_PUT = 'https://upload.test/thumb';
  const VIDEO_BYTES = 10_000;
  const headersOf = (map: Record<string, string | null>) => ({
    get: (name: string) => map[name.toLowerCase()] ?? null,
  });

  beforeEach(() => {
    thumbStatus = 200;
    thumbPutStatus = 201;
    returnsThumbnailUrl = true;
    mockFetchPublicMedia.mockClear();
    service = new LinkedInService();
    fetchMock = jest.fn().mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/rest/posts')) {
        return {
          ok: true,
          status: 201,
          headers: headersOf({ 'x-restli-id': 'urn:li:share:1' }),
          json: async () => ({}),
        };
      }
      if (url.includes('/rest/videos?action=initializeUpload')) {
        return {
          ok: true,
          json: async () => ({
            value: {
              video: 'urn:li:video:V1',
              uploadToken: 'tok-up',
              uploadInstructions: [
                {
                  uploadUrl: 'https://upload.test/p1',
                  firstByte: 0,
                  lastByte: VIDEO_BYTES - 1,
                },
              ],
              ...(returnsThumbnailUrl ? { thumbnailUploadUrl: THUMB_PUT } : {}),
            },
          }),
        };
      }
      if (url.includes('/rest/videos?action=finalizeUpload')) {
        return { ok: true, json: async () => ({}) };
      }
      if (url === THUMB_PUT) {
        return {
          ok: thumbPutStatus < 300,
          status: thumbPutStatus,
          text: async () => '{"message":"bad image"}',
        };
      }
      if (url.startsWith('https://upload.test/p')) {
        return {
          ok: true,
          headers: headersOf({ etag: 'etag-1' }),
          text: async () => '',
        };
      }
      if (url === THUMB) {
        return {
          ok: thumbStatus === 200,
          status: thumbStatus,
          headers: headersOf({ 'content-type': 'image/jpeg' }),
          arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer,
        };
      }
      // The video download from our storage.
      return {
        ok: true,
        headers: headersOf({}),
        arrayBuffer: async () => new ArrayBuffer(VIDEO_BYTES),
      };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const post = (options?: { thumbnailUrl?: string }) =>
    service.createRestVideoPost(
      'tok',
      'urn:li:person:me',
      'Watch',
      'https://cdn.test/v.mp4',
      undefined,
      'PUBLIC',
      false,
      options,
    );
  const urls = () => fetchMock.mock.calls.map(([u]) => String(u));
  const initBody = () =>
    JSON.parse(
      fetchMock.mock.calls.find(([u]) =>
        String(u).includes('action=initializeUpload'),
      )![1].body as string,
    );
  const thumbPut = () =>
    fetchMock.mock.calls.find(([u]) => String(u) === THUMB_PUT);

  it('asks for a thumbnail upload only when it holds a picture', async () => {
    await post({ thumbnailUrl: THUMB });
    expect(initBody().initializeUploadRequest.uploadThumbnail).toBe(true);
  });

  it('asks for none, and PUTs none, without a picture', async () => {
    const result = await post();
    expect(initBody().initializeUploadRequest.uploadThumbnail).toBe(false);
    expect(thumbPut()).toBeUndefined();
    expect(result).toEqual({ postId: 'urn:li:share:1' });
  });

  it('PUTs the image bytes to thumbnailUploadUrl as a still image', async () => {
    const result = await post({ thumbnailUrl: THUMB });
    const [, init] = thumbPut()!;
    expect(init.method).toBe('PUT');
    expect(init.headers['media-type-family']).toBe('STILLIMAGE');
    expect(init.headers['Content-Type']).toBe('application/octet-stream');
    expect(init.headers.Authorization).toBeUndefined();
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(
      new Uint8Array([9, 8, 7]),
    );
    expect(result).toEqual({ postId: 'urn:li:share:1' });
  });

  it('uploads the thumbnail after the video parts and before finalizing', async () => {
    await post({ thumbnailUrl: THUMB });
    const order = urls();
    const at = (pred: (u: string) => boolean) => order.findIndex(pred);
    const part = at((u) => u === 'https://upload.test/p1');
    const thumb = at((u) => u === THUMB_PUT);
    const finalize = at((u) => u.includes('finalizeUpload'));
    expect(part).toBeLessThan(thumb);
    expect(thumb).toBeLessThan(finalize);
  });

  it('downloads the thumbnail through the SSRF guard, before registering the video', async () => {
    await post({ thumbnailUrl: THUMB });
    expect(mockFetchPublicMedia).toHaveBeenCalledWith(
      THUMB,
      expect.objectContaining({ maxBytes: 10 * 1024 * 1024 }),
    );
    expect(urls().indexOf(THUMB)).toBeLessThan(
      urls().findIndex((u) => u.includes('initializeUpload')),
    );
  });

  it('posts without it, saying why, when the picture cannot be downloaded', async () => {
    thumbStatus = 404;
    const result = await post({ thumbnailUrl: THUMB });
    expect(initBody().initializeUploadRequest.uploadThumbnail).toBe(false);
    expect(thumbPut()).toBeUndefined();
    expect(result.postId).toBe('urn:li:share:1');
    expect(result.thumbnailWarning).toMatch(/HTTP 404/);
  });

  it('still posts, saying why, when LinkedIn refuses the thumbnail', async () => {
    thumbPutStatus = 400;
    const result = await post({ thumbnailUrl: THUMB });
    expect(urls().some((u) => u.includes('finalizeUpload'))).toBe(true);
    expect(result.postId).toBe('urn:li:share:1');
    expect(result.thumbnailWarning).toMatch(/bad image/);
  });

  it('still posts when LinkedIn returns no thumbnail upload address', async () => {
    returnsThumbnailUrl = false;
    const result = await post({ thumbnailUrl: THUMB });
    expect(result.postId).toBe('urn:li:share:1');
    expect(result.thumbnailWarning).toMatch(/no thumbnail upload address/);
  });
});
