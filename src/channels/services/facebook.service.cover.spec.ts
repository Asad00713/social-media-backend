import { FacebookService } from './facebook.service';

/**
 * A Reel's cover is `POST /{video-id}/thumbnails` - a multipart FILE upload
 * (`source`, at most 10 MB) plus `is_preferred=true` - made between the
 * transfer and the publish. So there are three things a wrong implementation
 * gets quietly wrong, and these tests pin each: the shape of that request, its
 * place in the sequence, and that a cover which cannot be set does not stop the
 * Reel publishing.
 */
describe('FacebookService.postReelToPage - the cover', () => {
  let service: FacebookService;
  let fetchMock: jest.Mock;
  let coverBytes: number;
  let coverStatus: number;
  let thumbResponse: { ok: boolean; status: number; body: unknown };

  const COVER = 'https://cdn.example/cover.png';

  const callsTo = (needle: string) =>
    fetchMock.mock.calls.filter((c) => String(c[0]).includes(needle));
  const indexOf = (needle: string) =>
    fetchMock.mock.calls.findIndex((c) => String(c[0]).includes(needle));

  beforeEach(() => {
    coverBytes = 1024;
    coverStatus = 200;
    thumbResponse = { ok: true, status: 200, body: { success: true } };
    service = new FacebookService();
    fetchMock = jest.fn().mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url === COVER) {
        return {
          ok: coverStatus === 200,
          status: coverStatus,
          headers: { get: () => 'image/png' },
          arrayBuffer: async () => new ArrayBuffer(coverBytes),
        };
      }
      if (url.endsWith('/vid-1/thumbnails')) {
        return {
          ok: thumbResponse.ok,
          status: thumbResponse.status,
          json: async () => thumbResponse.body,
        };
      }
      const body = url.includes('upload_phase=start')
        ? { video_id: 'vid-1', upload_url: 'https://rupload.example/vid-1' }
        : { success: true };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const post = (options: Parameters<FacebookService['postReelToPage']>[4]) =>
    service.postReelToPage(
      'page-1',
      'page-token',
      'https://cdn.example/v.mp4',
      'a caption',
      options,
    );

  it('uploads the image to the video’s /thumbnails edge as a multipart file', async () => {
    await post({ thumbnailUrl: COVER });

    const [call] = callsTo('/vid-1/thumbnails');
    expect(String(call[0])).toMatch(
      /graph\.facebook\.com\/v[\d.]+\/vid-1\/thumbnails$/,
    );
    expect(call[1].method).toBe('POST');

    const form = call[1].body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const source = form.get('source') as File;
    expect(source).toBeInstanceOf(Blob);
    expect(source.size).toBe(1024);
    expect(source.type).toBe('image/png');
    expect(form.get('is_preferred')).toBe('true');
    expect(form.get('access_token')).toBe('page-token');
  });

  it('does not set the headers itself, so fetch can write the multipart boundary', async () => {
    await post({ thumbnailUrl: COVER });
    expect(callsTo('/vid-1/thumbnails')[0][1].headers).toBeUndefined();
  });

  it('is set after the transfer and before the Reel is published', async () => {
    await post({ thumbnailUrl: COVER });
    const transfer = indexOf('rupload.example');
    const cover = indexOf('/vid-1/thumbnails');
    const finish = indexOf('upload_phase=finish');
    expect(transfer).toBeGreaterThan(-1);
    expect(cover).toBeGreaterThan(transfer);
    expect(finish).toBeGreaterThan(cover);
  });

  it('downloads the image from the URL it was given', async () => {
    await post({ thumbnailUrl: COVER });
    expect(callsTo(COVER)).toHaveLength(1);
  });

  it('is not attempted at all without a cover', async () => {
    await post({});
    await post(undefined);
    expect(callsTo('/thumbnails')).toHaveLength(0);
    expect(callsTo(COVER)).toHaveLength(0);
  });

  it('returns the Reel with no warning when the cover is set', async () => {
    expect(await post({ thumbnailUrl: COVER })).toEqual({ postId: 'vid-1' });
  });

  describe('when the cover cannot be set, the Reel is still published', () => {
    afterEach(() => {
      // Every case below: the publish call was still made.
      expect(callsTo('upload_phase=finish')).toHaveLength(1);
    });

    it('reports Facebook’s own reason', async () => {
      thumbResponse = {
        ok: false,
        status: 400,
        body: { error: { message: 'Video is still processing' } },
      };
      const result = await post({ thumbnailUrl: COVER });
      expect(result.postId).toBe('vid-1');
      expect(result.thumbnailWarning).toContain('Video is still processing');
    });

    it('reports a success:false answer', async () => {
      thumbResponse = { ok: true, status: 200, body: { success: false } };
      const result = await post({ thumbnailUrl: COVER });
      expect(result.thumbnailWarning).toBeDefined();
    });

    it('reports an image that cannot be downloaded, and makes no upload', async () => {
      coverStatus = 404;
      const result = await post({ thumbnailUrl: COVER });
      expect(result.postId).toBe('vid-1');
      expect(result.thumbnailWarning).toMatch(/could not be downloaded.*404/);
      expect(callsTo('/thumbnails')).toHaveLength(0);
    });

    it('reports an image over the 10 MB the edge takes, and makes no upload', async () => {
      coverBytes = 10 * 1024 * 1024 + 1;
      const result = await post({ thumbnailUrl: COVER });
      expect(result.thumbnailWarning).toMatch(/10 MB/);
      expect(callsTo('/thumbnails')).toHaveLength(0);
    });

    it('accepts an image of exactly 10 MB', async () => {
      coverBytes = 10 * 1024 * 1024;
      const result = await post({ thumbnailUrl: COVER });
      expect(result.thumbnailWarning).toBeUndefined();
      expect(callsTo('/thumbnails')).toHaveLength(1);
    });

    it('survives a network failure on the upload', async () => {
      const original = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input: unknown, init?: unknown) => {
        if (String(input).endsWith('/vid-1/thumbnails')) {
          throw new Error('socket hang up');
        }
        return original(input, init);
      });
      const result = await post({ thumbnailUrl: COVER });
      expect(result.postId).toBe('vid-1');
      expect(result.thumbnailWarning).toContain('socket hang up');
    });
  });

  it('works alongside a title: both reach Facebook, each in its own place', async () => {
    await post({ title: 'Iced latte', thumbnailUrl: COVER });
    const finish = new URL(
      String(fetchMock.mock.calls[indexOf('upload_phase=finish')][0]),
    );
    expect(finish.searchParams.get('title')).toBe('Iced latte');
    expect(finish.searchParams.has('thumbnailUrl')).toBe(false);
    expect(callsTo('/vid-1/thumbnails')).toHaveLength(1);
  });
});
