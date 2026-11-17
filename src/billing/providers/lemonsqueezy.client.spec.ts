import {
  LemonSqueezyClient,
  LS_REQUEST_TIMEOUT_MS,
} from './lemonsqueezy.client';

describe('LemonSqueezyClient', () => {
  const OLD_KEY = process.env.LEMONSQUEEZY_API_KEY;

  beforeEach(() => {
    process.env.LEMONSQUEEZY_API_KEY = 'test-key';
  });
  afterEach(() => {
    process.env.LEMONSQUEEZY_API_KEY = OLD_KEY;
    jest.restoreAllMocks();
  });

  function mockFetch(status: number, body: unknown) {
    const fn = jest.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
    });
    (global as unknown as { fetch: unknown }).fetch = fn;
    return fn;
  }

  it('sends the JSON:API content type Lemon Squeezy requires', async () => {
    const fetchMock = mockFetch(200, { data: {} });
    await new LemonSqueezyClient().get('subscriptions/1');
    const headers = fetchMock.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(headers['Accept']).toBe('application/vnd.api+json');
    expect(headers['Content-Type']).toBe('application/vnd.api+json');
  });

  it('cancels a call that hangs once the timeout fires, and says so', async () => {
    // AbortSignal.timeout runs on native timers that jest's fake clock cannot
    // advance, so hand the client a controllable signal and check the duration
    // it asked for.
    const controller = new AbortController();
    const timeout = jest
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(controller.signal);
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(init.signal.reason),
          );
        }),
    );

    const caught = new LemonSqueezyClient()
      .get('subscriptions/1')
      .catch((e: unknown) => e);
    controller.abort(new DOMException('timed out', 'TimeoutError'));

    expect(timeout).toHaveBeenCalledWith(LS_REQUEST_TIMEOUT_MS);
    expect(LS_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(String(await caught)).toContain(
      'subscriptions/1 timed out after 10000ms',
    );
  });

  it('gives every request an abort signal', async () => {
    const fetchMock = mockFetch(200, { data: {} });
    await new LemonSqueezyClient().get('subscriptions/1');
    await new LemonSqueezyClient().post('subscriptions', {});
    for (const call of fetchMock.mock.calls) {
      expect(call[1].signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('sends the bearer token', async () => {
    const fetchMock = mockFetch(200, { data: {} });
    await new LemonSqueezyClient().get('subscriptions/1');
    const headers = fetchMock.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(headers['Authorization']).toBe('Bearer test-key');
  });

  // An expiring key is a silent, total outage — Lemon Squeezy keys expire one
  // year after creation — so the error must say what happened.
  it('reports an auth failure in terms of the key', async () => {
    mockFetch(401, { errors: [{ detail: 'Unauthenticated' }] });
    await expect(
      new LemonSqueezyClient().get('subscriptions/1'),
    ).rejects.toThrow(/LEMONSQUEEZY_API_KEY/);
  });

  it('surfaces the provider error detail on other failures', async () => {
    mockFetch(422, { errors: [{ detail: 'Variant not found' }] });
    await expect(
      new LemonSqueezyClient().get('subscriptions/1'),
    ).rejects.toThrow(/Variant not found/);
  });

  it('throws a clear error when the key is missing entirely', async () => {
    delete process.env.LEMONSQUEEZY_API_KEY;
    await expect(
      new LemonSqueezyClient().get('subscriptions/1'),
    ).rejects.toThrow(/LEMONSQUEEZY_API_KEY/);
  });

  it('returns the parsed body on success', async () => {
    mockFetch(200, { data: { id: '2508067' } });
    await expect(
      new LemonSqueezyClient().get('subscriptions/1'),
    ).resolves.toEqual({ data: { id: '2508067' } });
  });
});
