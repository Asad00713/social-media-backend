import { FacebookService } from './facebook.service';

/**
 * A Reel's captions are `POST /{video-id}/captions` - a multipart FILE
 * (`captions_file`, SubRip, named `filename.locale.srt`, at most 200K) - made
 * after the Reel is published. These tests pin the request, its place in the
 * sequence, and that captions which cannot be set never fail a live Reel.
 */
describe('FacebookService.postReelToPage - the captions', () => {
  let service: FacebookService;
  let fetchMock: jest.Mock;
  let captionsResponse: { ok: boolean; status: number; body: unknown };

  const SRT = '1\n00:00:00,500 --> 00:00:02,000\nMorning!\n';

  const callsTo = (needle: string) =>
    fetchMock.mock.calls.filter((c) => String(c[0]).includes(needle));
  const indexOf = (needle: string) =>
    fetchMock.mock.calls.findIndex((c) => String(c[0]).includes(needle));

  beforeEach(() => {
    captionsResponse = { ok: true, status: 200, body: { success: true } };
    service = new FacebookService();
    fetchMock = jest.fn().mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/vid-1/captions')) {
        return {
          ok: captionsResponse.ok,
          status: captionsResponse.status,
          json: async () => captionsResponse.body,
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

  it('uploads the SubRip text to the video’s /captions edge as captions_file', async () => {
    await post({ captions: { srt: SRT, locale: 'en_US' } });

    const [call] = callsTo('/vid-1/captions');
    expect(String(call[0])).toMatch(
      /graph\.facebook\.com\/v[\d.]+\/vid-1\/captions$/,
    );
    expect(call[1].method).toBe('POST');

    const form = call[1].body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get('captions_file') as File;
    expect(file).toBeInstanceOf(Blob);
    expect(await file.text()).toBe(SRT);
    expect(form.get('access_token')).toBe('page-token');
  });

  it('names the file filename.locale.srt, as Meta requires', async () => {
    await post({ captions: { srt: SRT, locale: 'ur_PK' } });
    const form = callsTo('/vid-1/captions')[0][1].body as FormData;
    expect((form.get('captions_file') as File).name).toBe('captions.ur_PK.srt');
  });

  it('sends nothing optional: no default_locale, no locales_to_delete', async () => {
    await post({ captions: { srt: SRT, locale: 'en_US' } });
    const form = callsTo('/vid-1/captions')[0][1].body as FormData;
    expect([...form.keys()].sort()).toEqual(['access_token', 'captions_file']);
  });

  it('does not set the headers itself, so fetch can write the multipart boundary', async () => {
    await post({ captions: { srt: SRT, locale: 'en_US' } });
    expect(callsTo('/vid-1/captions')[0][1].headers).toBeUndefined();
  });

  it('is sent AFTER the Reel is published', async () => {
    await post({ captions: { srt: SRT, locale: 'en_US' } });
    const finish = indexOf('upload_phase=finish');
    const captions = indexOf('/vid-1/captions');
    expect(finish).toBeGreaterThan(-1);
    expect(captions).toBeGreaterThan(finish);
  });

  it('is not attempted at all without captions', async () => {
    await post({});
    await post(undefined);
    expect(callsTo('/captions')).toHaveLength(0);
  });

  it('returns the Reel with no warning when the captions are set', async () => {
    const result = await post({ captions: { srt: SRT, locale: 'en_US' } });
    expect(result).toEqual({ postId: 'vid-1' });
    // `toEqual` ignores an undefined key; the key itself must be absent.
    expect('captionsWarning' in result).toBe(false);
    expect('thumbnailWarning' in result).toBe(false);
  });

  describe('when the captions cannot be set, the Reel is still published', () => {
    afterEach(() => {
      expect(callsTo('upload_phase=finish')).toHaveLength(1);
    });

    it('reports Facebook’s own reason', async () => {
      captionsResponse = {
        ok: false,
        status: 400,
        body: {
          error: { message: 'Please use this format: filename.en_US.srt' },
        },
      };
      const result = await post({ captions: { srt: SRT, locale: 'en_US' } });
      expect(result.postId).toBe('vid-1');
      expect(result.captionsWarning).toContain('filename.en_US.srt');
    });

    it('reports a success:false answer', async () => {
      captionsResponse = { ok: true, status: 200, body: { success: false } };
      const result = await post({ captions: { srt: SRT, locale: 'en_US' } });
      expect(result.captionsWarning).toBeDefined();
    });

    it('refuses a file over 200K without sending it', async () => {
      const big = 'x'.repeat(200_001);
      const result = await post({ captions: { srt: big, locale: 'en_US' } });
      expect(result.captionsWarning).toMatch(/200K/);
      expect(callsTo('/captions')).toHaveLength(0);
    });

    it('accepts a file of exactly 200,000 bytes', async () => {
      const result = await post({
        captions: { srt: 'x'.repeat(200_000), locale: 'en_US' },
      });
      expect(result.captionsWarning).toBeUndefined();
      expect(callsTo('/captions')).toHaveLength(1);
    });

    it('measures BYTES, not characters', async () => {
      // 100,001 two-byte characters: 200,002 bytes.
      const result = await post({
        captions: { srt: 'é'.repeat(100_001), locale: 'en_US' },
      });
      expect(result.captionsWarning).toMatch(/200K/);
    });

    it('refuses a locale that is not Facebook’s shape', async () => {
      const result = await post({ captions: { srt: SRT, locale: 'eng' } });
      expect(result.captionsWarning).toMatch(/locale/);
      expect(callsTo('/captions')).toHaveLength(0);
    });

    it('survives a network failure on the upload', async () => {
      const original = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input: unknown, init?: unknown) => {
        if (String(input).endsWith('/vid-1/captions')) {
          throw new Error('socket hang up');
        }
        return original(input, init);
      });
      const result = await post({ captions: { srt: SRT, locale: 'en_US' } });
      expect(result.postId).toBe('vid-1');
      expect(result.captionsWarning).toContain('socket hang up');
    });
  });

  it('a failed cover and failed captions are both reported', async () => {
    captionsResponse = { ok: true, status: 200, body: { success: false } };
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: unknown, init?: unknown) => {
      if (String(input) === 'https://cdn.example/cover.png') {
        return { ok: false, status: 404 };
      }
      return original(input, init);
    });
    const result = await post({
      thumbnailUrl: 'https://cdn.example/cover.png',
      captions: { srt: SRT, locale: 'en_US' },
    });
    expect(result.thumbnailWarning).toBeDefined();
    expect(result.captionsWarning).toBeDefined();
  });
});
