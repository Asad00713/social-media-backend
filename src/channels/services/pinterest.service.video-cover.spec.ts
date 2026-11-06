import { PinterestService } from './pinterest.service';

/**
 * A video pin's cover, as the request body carries it.
 *
 * Pinterest wants a cover on a video pin: `cover_image_url`, or
 * `cover_image_key_frame_time` — a SECOND of the video. The composer
 * uploads the chosen frame and sends its URL; without one it still has
 * the second. These pin which key goes out, and that nothing is invented
 * from the video's own URL any more.
 */
describe('PinterestService.createPin — a video pin cover', () => {
  let service: PinterestService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    service = new PinterestService();
    fetchMock = jest.fn(async (url: string) => {
      if (url.endsWith('/media')) {
        return {
          ok: true,
          json: async () => ({
            media_id: '123',
            upload_url: 'https://upload.test/',
            upload_parameters: { key: 'k' },
          }),
        };
      }
      if (url === VIDEO) {
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
      }
      if (url === 'https://upload.test/') return { ok: true };
      if (url.endsWith('/media/123')) {
        return { ok: true, json: async () => ({ status: 'succeeded' }) };
      }
      // POST /pins
      return { ok: true, json: async () => ({ id: 'pin-1' }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const VIDEO = 'https://cdn.test/clip.mp4';

  /** The media_source of the one POST /pins that went out. */
  const mediaSourceFor = async (
    options: Parameters<PinterestService['createPin']>[5],
  ) => {
    await service.createPin('token', 'board-1', 'Title', 'Desc', VIDEO, {
      mediaType: 'video',
      ...options,
    });
    const pins = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/pins'),
    );
    expect(pins).toHaveLength(1);
    return JSON.parse(pins[0][1].body as string).media_source;
  };

  it('sends the uploaded frame as the cover image', async () => {
    const source = await mediaSourceFor({
      videoCoverImageUrl: 'https://cdn.test/frame.jpg',
      coverKeyFrameSec: 4,
    });

    expect(source.cover_image_url).toBe('https://cdn.test/frame.jpg');
    // One cover, not two: the URL is the choice when it exists.
    expect('cover_image_key_frame_time' in source).toBe(false);
    expect(source.media_id).toBe('123');
  });

  it('falls back to the stored second as the key frame', async () => {
    const source = await mediaSourceFor({ coverKeyFrameSec: 2.5 });

    expect(source.cover_image_key_frame_time).toBe(2.5);
    expect('cover_image_url' in source).toBe(false);
  });

  it('uses the first frame when nothing was chosen', async () => {
    const source = await mediaSourceFor({});

    expect(source.cover_image_key_frame_time).toBe(0);
  });

  it.each([
    ['negative', -3],
    ['not finite', Number.POSITIVE_INFINITY],
  ])('ignores a key frame that is %s', async (_label, sec) => {
    const source = await mediaSourceFor({ coverKeyFrameSec: sec });

    expect(source.cover_image_key_frame_time).toBe(0);
  });

  // The old fallback: swap `.mp4` for `.jpg` and hope a file is there.
  it('never invents a cover URL from the video URL', async () => {
    await mediaSourceFor({});

    const sent = fetchMock.mock.calls
      .map(([, init]) => String(init?.body ?? ''))
      .join('\n');
    expect(sent).not.toContain('clip.jpg');
  });
});
