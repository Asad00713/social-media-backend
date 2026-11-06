import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AltTextService } from './alt-text.service';

const WS = 'ws-1';
const USER = 'user-1';
const ITEM = 'item-1';

function build(item: Record<string, unknown>) {
  const mediaItems = {
    findOne: jest.fn().mockResolvedValue({
      id: ITEM,
      name: 'Bike',
      type: 'image',
      fileUrl: 'https://res.cloudinary.com/demo/image/upload/v1/x.jpg',
      ...item,
    }),
    update: jest.fn(),
  };
  const storageObjects = {
    isOwnStorageUrl: jest.fn().mockReturnValue(true),
  };
  const aiTokens = {
    checkTokens: jest.fn().mockResolvedValue({ hasAccess: true }),
    executeWithTokens: jest.fn(
      async (
        _ws: string,
        _u: string,
        _op: string,
        _p: unknown,
        _s: string,
        fn: () => Promise<{ result: unknown }>,
      ) => ({ result: (await fn()).result, usage: {} }),
    ),
  };
  const aiText = {
    describeImage: jest.fn().mockResolvedValue('"Image of a red bike."'),
  };
  // The Claude client is mocked: no test here reaches a live model.
  const claude = {
    isReady: jest.fn().mockReturnValue(false),
    describeImage: jest.fn().mockResolvedValue('Image of a blue door.'),
  };
  const svc = new AltTextService(
    mediaItems as any,
    storageObjects as any,
    aiTokens as any,
    aiText as any,
    claude as any,
  );
  return { svc, mediaItems, storageObjects, aiTokens, aiText, claude };
}

function mockFetch(
  body = new Uint8Array([1, 2, 3]),
  headers: Record<string, string> = { 'content-type': 'image/jpeg' },
) {
  return jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response(body, { status: 200, headers }));
}

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const ex = e as HttpException;
    return { status: ex.getStatus(), body: ex.getResponse() as any };
  }
  throw new Error('expected rejection');
}

describe('AltTextService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('rejects a video with 422 NOT_AN_IMAGE before any token check', async () => {
    const { svc, aiTokens } = build({ type: 'video' });
    const r = await failure(svc.generate(WS, USER, ITEM));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('NOT_AN_IMAGE');
    expect(aiTokens.checkTokens).not.toHaveBeenCalled();
  });

  it('rejects a foreign URL with 422 and never fetches it', async () => {
    const { svc, storageObjects, aiTokens } = build({});
    storageObjects.isOwnStorageUrl.mockReturnValue(false);
    const fetchSpy = mockFetch();
    const r = await failure(svc.generate(WS, USER, ITEM));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('NOT_AN_IMAGE');
    expect(aiTokens.checkTokens).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 402 AI_TOKENS_EXHAUSTED without calling the model', async () => {
    const { svc, aiTokens, aiText } = build({});
    aiTokens.checkTokens.mockResolvedValue({ hasAccess: false });
    const r = await failure(svc.generate(WS, USER, ITEM));
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('AI_TOKENS_EXHAUSTED');
    expect(aiText.describeImage).not.toHaveBeenCalled();
    expect(aiTokens.executeWithTokens).not.toHaveBeenCalled();
  });

  it.each([
    ['ForbiddenException', new ForbiddenException('no ai')],
    ['BadRequestException', new BadRequestException('insufficient')],
  ])(
    'maps %s from executeWithTokens (callback never ran) to 402',
    async (_name, err) => {
      const { svc, aiTokens, aiText } = build({});
      aiTokens.executeWithTokens.mockRejectedValue(err);
      const r = await failure(svc.generate(WS, USER, ITEM));
      expect(r.status).toBe(402);
      expect(r.body.code).toBe('AI_TOKENS_EXHAUSTED');
      expect(aiText.describeImage).not.toHaveBeenCalled();
    },
  );

  it('keeps a 422 thrown from inside the callback as 422', async () => {
    const { svc, aiText } = build({});
    mockFetch(new Uint8Array([1]), { 'content-type': 'text/html' });
    const r = await failure(svc.generate(WS, USER, ITEM));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('NOT_AN_IMAGE');
    expect(aiText.describeImage).not.toHaveBeenCalled();
  });

  it('does not turn a Forbidden thrown inside the callback into 402', async () => {
    const { svc, aiText } = build({});
    mockFetch();
    aiText.describeImage.mockRejectedValue(new ForbiddenException('inner'));
    const r = await failure(svc.generate(WS, USER, ITEM));
    expect(r.status).toBe(403);
  });

  it('refuses an image over 8 MB with 422', async () => {
    const { svc } = build({});
    mockFetch(new Uint8Array(8 * 1024 * 1024 + 1));
    await expect(svc.generate(WS, USER, ITEM)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('returns cleaned alt text, meters generate_alt_text, and never saves', async () => {
    const { svc, aiTokens, aiText, mediaItems } = build({});
    const fetchSpy = mockFetch();
    const out = await svc.generate(WS, USER, ITEM);
    expect(out).toEqual({ altText: 'a red bike.' });
    expect(aiTokens.executeWithTokens).toHaveBeenCalledWith(
      WS,
      USER,
      'generate_alt_text',
      undefined,
      'alt text: Bike',
      expect.any(Function),
    );
    expect(fetchSpy.mock.calls[0][0]).toContain('f_jpg,w_1024,c_limit/');
    expect(aiText.describeImage.mock.calls[0][2]).toEqual({
      mimeType: 'image/jpeg',
      data: Buffer.from([1, 2, 3]).toString('base64'),
    });
    expect(aiText.describeImage.mock.calls[0][3]).toEqual({ maxTokens: 120 });
    expect(mediaItems.update).not.toHaveBeenCalled();
  });

  it('refuses a redirect (fetch is called with redirect: error)', async () => {
    const { svc, aiText } = build({});
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new TypeError('fetch failed'));
    await expect(svc.generate(WS, USER, ITEM)).rejects.toThrow();
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    expect(aiText.describeImage).not.toHaveBeenCalled();
  });

  it('returns 404 for a binned item and does not meter', async () => {
    const { svc, aiTokens } = build({ isDeleted: true });
    const r = await failure(svc.generate(WS, USER, ITEM));
    expect(r.status).toBe(404);
    expect(aiTokens.checkTokens).not.toHaveBeenCalled();
  });

  it('refuses image/gif with 422 before calling the provider', async () => {
    const { svc, aiText } = build({});
    mockFetch(new Uint8Array([1]), { 'content-type': 'image/gif' });
    const r = await failure(svc.generate(WS, USER, ITEM));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('NOT_AN_IMAGE');
    expect(aiText.describeImage).not.toHaveBeenCalled();
  });

  it('throws 502 inside the callback when the reply cleans to empty', async () => {
    const { svc, aiTokens, aiText } = build({});
    mockFetch();
    aiText.describeImage.mockResolvedValue('  "" ');
    const r = await failure(svc.generate(WS, USER, ITEM));
    expect(r.status).toBe(502);
    expect(aiTokens.executeWithTokens).toHaveBeenCalled();
  });

  it('aborts a chunked body without content-length once it exceeds the cap', async () => {
    const { svc, aiText } = build({});
    const abortSpy = jest.spyOn(AbortController.prototype, 'abort');
    const chunk = new Uint8Array(5 * 1024 * 1024);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls += 1;
        c.enqueue(chunk);
        if (pulls > 20) c.close();
      },
    });
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    const r = await failure(svc.generate(WS, USER, ITEM));
    expect(r.status).toBe(422);
    expect(abortSpy).toHaveBeenCalled();
    expect(pulls).toBeLessThan(5);
    expect(aiText.describeImage).not.toHaveBeenCalled();
  });

  describe('generateForUrl (composer draft photo)', () => {
    const URL_ = 'https://res.cloudinary.com/demo/image/upload/v1/d.png';

    it('refuses a URL outside our storage with 422, before tokens or fetch', async () => {
      const { svc, storageObjects, aiTokens, claude } = build({});
      storageObjects.isOwnStorageUrl.mockReturnValue(false);
      const fetchSpy = mockFetch();
      const r = await failure(
        svc.generateForUrl(WS, USER, 'https://evil.example/x.png'),
      );
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('NOT_AN_IMAGE');
      expect(storageObjects.isOwnStorageUrl).toHaveBeenCalledWith(
        'https://evil.example/x.png',
      );
      expect(aiTokens.checkTokens).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(claude.describeImage).not.toHaveBeenCalled();
    });

    it('uses Claude when it is configured, metered as generate_alt_text', async () => {
      const { svc, aiTokens, aiText, claude } = build({});
      claude.isReady.mockReturnValue(true);
      const fetchSpy = mockFetch(new Uint8Array([9, 8]), {
        'content-type': 'image/png',
      });
      const out = await svc.generateForUrl(WS, USER, URL_);
      expect(out).toEqual({ altText: 'a blue door.' });
      expect(aiTokens.executeWithTokens).toHaveBeenCalledWith(
        WS,
        USER,
        'generate_alt_text',
        undefined,
        'alt text: draft photo',
        expect.any(Function),
      );
      expect(fetchSpy.mock.calls[0][0]).toContain('f_jpg,w_1024,c_limit/');
      expect(claude.describeImage.mock.calls[0][2]).toEqual({
        mimeType: 'image/png',
        data: Buffer.from([9, 8]).toString('base64'),
      });
      expect(aiText.describeImage).not.toHaveBeenCalled();
    });

    it('accepts a GIF for Claude (it reads GIF; Gemini here does not)', async () => {
      const { svc, claude } = build({});
      claude.isReady.mockReturnValue(true);
      mockFetch(new Uint8Array([1]), { 'content-type': 'image/gif' });
      await expect(svc.generateForUrl(WS, USER, URL_)).resolves.toEqual({
        altText: 'a blue door.',
      });
    });

    it('refuses HEIC for Claude with 422, without calling it', async () => {
      const { svc, claude } = build({});
      claude.isReady.mockReturnValue(true);
      mockFetch(new Uint8Array([1]), { 'content-type': 'image/heic' });
      const r = await failure(svc.generateForUrl(WS, USER, URL_));
      expect(r.status).toBe(422);
      expect(claude.describeImage).not.toHaveBeenCalled();
    });

    it('falls back to Gemini when Claude is not configured', async () => {
      const { svc, aiText, claude } = build({});
      mockFetch();
      await expect(svc.generateForUrl(WS, USER, URL_)).resolves.toEqual({
        altText: 'a red bike.',
      });
      expect(claude.describeImage).not.toHaveBeenCalled();
      expect(aiText.describeImage).toHaveBeenCalled();
    });

    it('returns 402 when out of tokens, without fetching', async () => {
      const { svc, aiTokens } = build({});
      aiTokens.checkTokens.mockResolvedValue({ hasAccess: false });
      const fetchSpy = mockFetch();
      const r = await failure(svc.generateForUrl(WS, USER, URL_));
      expect(r.status).toBe(402);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  it('the Library path never uses Claude, even when it is configured', async () => {
    const { svc, claude, aiText } = build({});
    claude.isReady.mockReturnValue(true);
    mockFetch();
    await svc.generate(WS, USER, ITEM);
    expect(claude.describeImage).not.toHaveBeenCalled();
    expect(aiText.describeImage).toHaveBeenCalled();
  });

  it('accepts a streamed body under the cap', async () => {
    const { svc } = build({});
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2]));
        c.enqueue(new Uint8Array([3]));
        c.close();
      },
    });
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    await expect(svc.generate(WS, USER, ITEM)).resolves.toEqual({
      altText: 'a red bike.',
    });
  });
});
