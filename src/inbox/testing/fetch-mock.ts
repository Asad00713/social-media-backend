/**
 * A typed stand-in for the global `fetch`, for specs that check the exact
 * request an adapter makes (URL, method, body) without touching the network.
 */
export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type FetchResponder = (req: RecordedRequest) => Response | undefined;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function mockFetch(responder?: FetchResponder): {
  requests: RecordedRequest[];
  restore: () => void;
} {
  const requests: RecordedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const rawBody = init?.body;
    const req: RecordedRequest = {
      url:
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined,
    };
    requests.push(req);
    return Promise.resolve(responder?.(req) ?? json({}));
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
