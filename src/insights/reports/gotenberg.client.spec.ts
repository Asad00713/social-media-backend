import {
  GotenbergClient,
  GotenbergError,
  GotenbergNotConfiguredError,
} from './gotenberg.client';

const PDF = new TextEncoder().encode('%PDF-1.7 body');

function fetchFake(respond: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = jest.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init: init as RequestInit });
    return Promise.resolve(respond());
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('GotenbergClient', () => {
  it('posts the page url as a multipart form to the Chromium route', async () => {
    const { impl, calls } = fetchFake(() => new Response(PDF, { status: 200 }));
    const pdf = await new GotenbergClient('http://g:3000/', impl).pdfFromUrl(
      'https://app.schedura.ai/r/tok?print=1',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://g:3000/forms/chromium/convert/url');
    expect(calls[0].init.method).toBe('POST');
    const form = calls[0].init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('url')).toBe('https://app.schedura.ai/r/tok?print=1');
    expect(form.get('waitForExpression')).toBe('window.__reportReady === true');
    expect(form.get('printBackground')).toBe('true');
    expect(form.get('paperWidth')).toBe('8.27');
    expect(form.get('paperHeight')).toBe('11.7');
    for (const side of ['Top', 'Bottom', 'Left', 'Right']) {
      expect(form.get(`margin${side}`)).toBe('0');
    }
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('throws GotenbergError carrying the status on a non-2xx answer', async () => {
    const { impl } = fetchFake(() => new Response('boom', { status: 500 }));
    const err = await new GotenbergClient('http://g:3000', impl)
      .pdfFromUrl('https://x.test/')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GotenbergError);
    expect((err as Error).message).toContain('500');
  });

  it('throws GotenbergError "timed out after <n>s" when fetch never answers', async () => {
    // Rejects when the client's signal aborts, as the real fetch does.
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason as Error),
        );
      })) as unknown as typeof fetch;
    const err = await new GotenbergClient('http://g:3000', hanging, 20)
      .pdfFromUrl('https://x.test/')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GotenbergError);
    expect((err as Error).message).toBe('timed out after 0.02s');
    expect((err as GotenbergError).kind).toBe('timeout');
  });

  it('marks a non-2xx answer as failed, not a timeout', async () => {
    const { impl } = fetchFake(() => new Response('boom', { status: 502 }));
    const err = await new GotenbergClient('http://g:3000', impl)
      .pdfFromUrl('https://x.test/')
      .catch((e: unknown) => e);
    expect((err as GotenbergError).kind).toBe('failed');
  });

  it('throws GotenbergError (failed) when the body errors while it streams in', async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    const { impl } = fetchFake(() => new Response(broken, { status: 200 }));
    const err = await new GotenbergClient('http://g:3000', impl)
      .pdfFromUrl('https://x.test/')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GotenbergError);
    expect((err as GotenbergError).kind).toBe('failed');
    expect((err as Error).message).toContain('connection reset');
  });

  it('throws GotenbergError (timeout) when the body stalls until the abort', async () => {
    const stalled = ((_url: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () =>
            controller.error(init.signal?.reason as Error),
          );
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as unknown as typeof fetch;
    const err = await new GotenbergClient('http://g:3000', stalled, 20)
      .pdfFromUrl('https://x.test/')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GotenbergError);
    expect((err as GotenbergError).kind).toBe('timeout');
  });

  it('throws GotenbergError when Gotenberg cannot be reached', async () => {
    const down = (() =>
      Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    await expect(
      new GotenbergClient('http://g:3000', down).pdfFromUrl('https://x.test/'),
    ).rejects.toThrow(/could not be reached: fetch failed/);
  });

  it('is not configured without a url, and refuses to render', async () => {
    const { impl, calls } = fetchFake(() => new Response(PDF));
    for (const unset of [undefined, '', '  ']) {
      const client = new GotenbergClient(unset, impl);
      expect(client.isConfigured()).toBe(false);
      await expect(client.pdfFromUrl('x')).rejects.toBeInstanceOf(
        GotenbergNotConfiguredError,
      );
    }
    expect(calls).toHaveLength(0);
    expect(new GotenbergClient('http://g:3000').isConfigured()).toBe(true);
  });

  it('carries the exact 503 message', () => {
    expect(new GotenbergNotConfiguredError().getStatus()).toBe(503);
    expect(new GotenbergNotConfiguredError().message).toBe(
      "PDF export isn't set up on this server.",
    );
  });
});
