import * as http from 'http';
import type { AddressInfo } from 'net';
import { fetch as undiciFetch } from 'undici';
import {
  fetchPublicMedia,
  publicAgent,
  UnsafeMediaUrlError,
} from './public-fetch';

jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { ...actual, fetch: jest.fn(actual.fetch) };
});
const mockedFetch = undiciFetch as unknown as jest.Mock;
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- requireActual is untyped under this jest config
const realUndiciFetch = jest.requireActual('undici').fetch as never;

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

describe('fetchPublicMedia', () => {
  beforeEach(() => mockedFetch.mockReset());

  it.each([
    'http://127.0.0.1/a.jpg',
    'http://10.0.0.5/video.mp4',
    'http://172.16.3.4/img.png',
    'http://192.168.1.10/img.png',
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://[fd00:ec2::254]/latest/meta-data/',
    'http://[::1]:6379/',
    'http://[::ffff:127.0.0.1]/',
    'http://0.0.0.0:3000/',
  ])('refuses private / metadata / loopback target %s', async (url) => {
    await expect(fetchPublicMedia(url)).rejects.toThrow(UnsafeMediaUrlError);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it.each([
    'file:///etc/passwd',
    'ftp://example.com/a.jpg',
    'gopher://example.com/',
    'data:image/png;base64,AAAA',
  ])('refuses non-http scheme %s', async (url) => {
    await expect(fetchPublicMedia(url)).rejects.toThrow(UnsafeMediaUrlError);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('fetches a public URL through the pinned agent, redirects manual', async () => {
    mockedFetch.mockResolvedValue(
      new Response('bytes', {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }),
    );
    const res = await fetchPublicMedia('https://cdn.example.com/a.jpg');
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('bytes');
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0] as [
      string,
      { redirect: string; dispatcher: unknown },
    ];
    expect(url).toBe('https://cdn.example.com/a.jpg');
    expect(init.redirect).toBe('manual');
    expect(init.dispatcher).toBe(publicAgent);
  });

  it('follows a public redirect, re-checking the next hop', async () => {
    mockedFetch
      .mockResolvedValueOnce(redirect('/real.jpg', 301))
      .mockResolvedValueOnce(new Response('ok'));
    const res = await fetchPublicMedia('https://cdn.example.com/a.jpg');
    expect(await res.text()).toBe('ok');
    expect((mockedFetch.mock.calls as [string][]).map((c) => c[0])).toEqual([
      'https://cdn.example.com/a.jpg',
      'https://cdn.example.com/real.jpg',
    ]);
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:6379/',
    'http://[::1]/',
    'file:///etc/passwd',
  ])('refuses a redirect to %s', async (location) => {
    mockedFetch.mockResolvedValueOnce(redirect(location));
    await expect(
      fetchPublicMedia('https://cdn.example.com/a.jpg'),
    ).rejects.toThrow(UnsafeMediaUrlError);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('gives up after 5 redirects', async () => {
    mockedFetch.mockImplementation(() =>
      Promise.resolve(redirect('https://cdn.example.com/loop')),
    );
    await expect(
      fetchPublicMedia('https://cdn.example.com/a.jpg'),
    ).rejects.toThrow(/Too many redirects/);
    expect(mockedFetch).toHaveBeenCalledTimes(6);
  });

  it('returns a non-2xx answer as-is, like fetch', async () => {
    mockedFetch.mockResolvedValue(new Response('nope', { status: 404 }));
    const res = await fetchPublicMedia('https://cdn.example.com/a.jpg');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });

  it('refuses a body whose declared length is over the cap', async () => {
    mockedFetch.mockResolvedValue(
      new Response('x'.repeat(20), { headers: { 'content-length': '20' } }),
    );
    await expect(
      fetchPublicMedia('https://cdn.example.com/a.jpg', { maxBytes: 10 }),
    ).rejects.toThrow(UnsafeMediaUrlError);
  });

  it('errors the stream once an undeclared body passes the cap', async () => {
    mockedFetch.mockResolvedValue(new Response('x'.repeat(20)));
    const res = await fetchPublicMedia('https://cdn.example.com/a.jpg', {
      maxBytes: 10,
    });
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it('never reaches a loopback server by hostname (connect-time check)', async () => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.end('secret');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    mockedFetch.mockImplementation(realUndiciFetch);
    try {
      await expect(
        fetchPublicMedia(`http://localhost:${port}/secret`),
      ).rejects.toThrow();
      expect(hits).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
