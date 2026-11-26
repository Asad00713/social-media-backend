import {
  PaddleClient,
  PADDLE_API_BASE_ENV,
  PADDLE_API_KEY_ENV,
  PADDLE_API_VERSION,
  PADDLE_LIVE_BASE,
  PADDLE_REQUEST_TIMEOUT_MS,
  PADDLE_SANDBOX_BASE,
} from './paddle.client';

describe('PaddleClient', () => {
  const OLD_KEY = process.env[PADDLE_API_KEY_ENV];
  const OLD_BASE = process.env[PADDLE_API_BASE_ENV];

  beforeEach(() => {
    process.env[PADDLE_API_KEY_ENV] = 'pdl_sdbx_apikey_test';
    process.env[PADDLE_API_BASE_ENV] = PADDLE_SANDBOX_BASE;
  });
  afterEach(() => {
    if (OLD_KEY === undefined) delete process.env[PADDLE_API_KEY_ENV];
    else process.env[PADDLE_API_KEY_ENV] = OLD_KEY;
    if (OLD_BASE === undefined) delete process.env[PADDLE_API_BASE_ENV];
    else process.env[PADDLE_API_BASE_ENV] = OLD_BASE;
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

  // ------------------------------------------------------------ environment

  it('calls the host the environment names, not a compiled-in one', async () => {
    // THE reason this client reads a variable at all. Paddle's sandbox and
    // live APIs are different hosts, so a module constant like
    // `lemonsqueezy.client.ts`'s BASE would hard-code the environment — the
    // same shape that once let PINTEREST_USE_SANDBOX=true reach production.
    const fetchMock = mockFetch(200, { data: {} });
    await new PaddleClient().get('subscriptions/sub_1');
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${PADDLE_SANDBOX_BASE}/subscriptions/sub_1`,
    );

    process.env[PADDLE_API_BASE_ENV] = PADDLE_LIVE_BASE;
    await new PaddleClient().get('subscriptions/sub_1');
    expect(fetchMock.mock.calls[1][0]).toBe(
      `${PADDLE_LIVE_BASE}/subscriptions/sub_1`,
    );
  });

  it('refuses to guess a host when the variable is missing', async () => {
    // Defaulting to sandbox would bill nobody in production; defaulting to
    // live would bill real cards from a laptop. Neither is recoverable by the
    // time anyone notices, so there is no default.
    delete process.env[PADDLE_API_BASE_ENV];
    const fetchMock = mockFetch(200, { data: {} });

    await expect(new PaddleClient().get('subscriptions/sub_1')).rejects.toThrow(
      new RegExp(PADDLE_API_BASE_ENV),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names both hosts in the setup error, so the fix needs no doc lookup', async () => {
    delete process.env[PADDLE_API_BASE_ENV];
    const err = await new PaddleClient()
      .get('subscriptions/sub_1')
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain(PADDLE_SANDBOX_BASE);
    expect((err as Error).message).toContain(PADDLE_LIVE_BASE);
  });

  it('tolerates a trailing slash on the configured base', async () => {
    // A copy-paste from the docs or a dashboard often carries one, and
    // `//subscriptions` is a 404 that looks like a missing subscription.
    process.env[PADDLE_API_BASE_ENV] = `${PADDLE_SANDBOX_BASE}/`;
    const fetchMock = mockFetch(200, { data: {} });
    await new PaddleClient().get('/subscriptions/sub_1');
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${PADDLE_SANDBOX_BASE}/subscriptions/sub_1`,
    );
  });

  it('refuses to call without a key', async () => {
    delete process.env[PADDLE_API_KEY_ENV];
    const fetchMock = mockFetch(200, { data: {} });
    await expect(new PaddleClient().get('subscriptions/sub_1')).rejects.toThrow(
      new RegExp(PADDLE_API_KEY_ENV),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------- headers

  it('pins the API version on every request', async () => {
    // Without the header Paddle uses the ACCOUNT's default version, which is
    // whatever was current when that account was created. The response shape
    // would then be a property of the account rather than of this code.
    const fetchMock = mockFetch(200, { data: {} });
    await new PaddleClient().get('subscriptions/sub_1');
    const headers = fetchMock.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(headers['Paddle-Version']).toBe(PADDLE_API_VERSION);
    expect(headers['Authorization']).toBe('Bearer pdl_sdbx_apikey_test');
    expect(headers['Content-Type']).toBe('application/json');
  });

  // ----------------------------------------------------------------- errors

  it('surfaces Paddle\u2019s own error detail', async () => {
    mockFetch(400, {
      error: {
        type: 'request_error',
        code: 'subscription_update_error',
        detail: 'proration_billing_mode is required',
      },
    });
    await expect(
      new PaddleClient().patch('subscriptions/sub_1', {}),
    ).rejects.toThrow(/proration_billing_mode is required/);
  });

  it('falls back to the error code when there is no detail', async () => {
    mockFetch(400, { error: { code: 'bad_request' } });
    await expect(new PaddleClient().post('transactions', {})).rejects.toThrow(
      /bad_request/,
    );
  });

  it('blames the environment on a rejected credential, naming the host', async () => {
    // The commonest Paddle setup failure is a correct key for the OTHER
    // environment. "Unauthorized" sends someone to regenerate a key that was
    // never wrong; the host is the thing to check.
    mockFetch(403, { error: { detail: 'Forbidden' } });
    const err = await new PaddleClient()
      .get('subscriptions/sub_1')
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain(PADDLE_API_KEY_ENV);
    expect((err as Error).message).toContain(PADDLE_SANDBOX_BASE);
  });

  it('handles an empty body without throwing a parse error', async () => {
    const fn = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    (global as unknown as { fetch: unknown }).fetch = fn;
    await expect(new PaddleClient().get('subscriptions/sub_1')).resolves.toEqual(
      {},
    );
  });

  // ---------------------------------------------------------------- timeout

  it('cancels a call that hangs once the timeout fires, and says so', async () => {
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

    const caught = new PaddleClient()
      .get('subscriptions/sub_1')
      .catch((e: unknown) => e);
    controller.abort(new DOMException('timed out', 'TimeoutError'));

    expect(timeout).toHaveBeenCalledWith(PADDLE_REQUEST_TIMEOUT_MS);
    expect((await caught as Error).message).toMatch(/timed out/);
  });
});
