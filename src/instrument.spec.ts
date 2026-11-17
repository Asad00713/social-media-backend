const init = jest.fn();
jest.mock('@sentry/nestjs', () => ({ init }));

/** A real JWT shape — this is what must never reach a third-party dashboard. */
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOiJ4In0.c2ln-_x';

type Hooks = {
  beforeSend: (event: Record<string, any>) => Record<string, any>;
  beforeSendTransaction: (event: Record<string, any>) => Record<string, any>;
  beforeSendSpan: (span: Record<string, any>) => Record<string, any>;
  enabled: boolean;
  sendDefaultPii: boolean;
};

function load(env: Record<string, string | undefined> = {}): Hooks {
  jest.resetModules();
  init.mockClear();
  const previous = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    // Assigning undefined leaves the var set to the string "undefined";
    // only delete actually unsets it.
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./instrument');
  } finally {
    process.env = previous;
  }
  return init.mock.calls[0][0] as Hooks;
}

describe('Sentry initialisation', () => {
  it('is disabled when no DSN is configured', () => {
    expect(load({ SENTRY_DSN: undefined }).enabled).toBe(false);
  });

  it('is enabled once a DSN is configured', () => {
    expect(load({ SENTRY_DSN: 'https://k@o.ingest.sentry.io/1' }).enabled).toBe(
      true,
    );
  });

  it('never lets Sentry attach PII of its own', () => {
    expect(load().sendDefaultPii).toBe(false);
  });

  describe('scrubbing', () => {
    /**
     * Some of this app's URLs *are* the credential — a report link, an email
     * unsubscribe link. `sendDefaultPii: false` does not withhold the URL, so
     * without this the token lands in a third-party dashboard intact.
     */
    it('redacts a token out of the request URL', () => {
      const { beforeSend } = load();
      const event = beforeSend({
        request: { url: `https://api.example.com/email/unsubscribe/${TOKEN}` },
      });
      expect(JSON.stringify(event)).not.toContain(TOKEN);
    });

    it('drops the body, query string, cookies and headers entirely', () => {
      const { beforeSend } = load();
      const event = beforeSend({
        request: {
          url: 'https://api.example.com/auth/login',
          data: { password: 'hunter2' },
          query_string: `token=${TOKEN}`,
          cookies: { session: 'abc' },
          headers: { authorization: `Bearer ${TOKEN}` },
        },
      });

      const serialised = JSON.stringify(event);
      expect(serialised).not.toContain('hunter2');
      expect(serialised).not.toContain(TOKEN);
      expect(serialised).not.toContain('abc');
    });

    /**
     * Transactions are sampled independently of errors, so a token could
     * reach Sentry through tracing even if nothing ever threw.
     */
    it('redacts the transaction name and its URL', () => {
      const { beforeSendTransaction } = load();
      const event = beforeSendTransaction({
        transaction: `GET /email/unsubscribe/${TOKEN}`,
        request: { url: `https://api.example.com/email/unsubscribe/${TOKEN}` },
      });
      expect(JSON.stringify(event)).not.toContain(TOKEN);
    });

    it('redacts URLs carried on span attributes', () => {
      const { beforeSendSpan } = load();
      const span = beforeSendSpan({
        data: {
          'http.url': `https://api.example.com/email/unsubscribe/${TOKEN}`,
          'url.full': `https://api.example.com/reports/public/${TOKEN}`,
        },
      });
      expect(JSON.stringify(span)).not.toContain(TOKEN);
    });

    it('leaves an ordinary URL alone', () => {
      const { beforeSend } = load();
      const event = beforeSend({
        request: { url: 'https://api.example.com/posts/123' },
      });
      expect(event.request.url).toBe('https://api.example.com/posts/123');
    });

    it('tolerates an event with no request at all', () => {
      const { beforeSend } = load();
      expect(() => beforeSend({})).not.toThrow();
    });
  });
});
