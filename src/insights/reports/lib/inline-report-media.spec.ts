import { fetch as undiciFetch } from 'undici';

// The PDF is printed by Gotenberg's Chromium, inside our network. Any image
// URL the print page carries is fetched from THERE, so the render payload
// must carry no user-supplied URL at all: each image is fetched by us,
// through the SSRF guard, and inlined as a data: URI (or dropped).
jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { ...actual, fetch: jest.fn() };
});
const mockedFetch = undiciFetch as unknown as jest.Mock;

import { publicAgent } from '../../../common/net/public-fetch';
import type { ReportPayloadDto } from '../reports.dto';
import {
  inlineReportMedia,
  REPORT_IMAGE_MAX_BYTES,
} from './inline-report-media';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DATA = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`;
const PUBLIC_LOGO = 'https://93.184.216.34/logo.png';

const PRIVATE_URLS = [
  'http://127.0.0.1/logo.png',
  'http://169.254.169.254/latest/meta-data/',
  'http://10.0.0.8/logo.png',
  'http://[::1]/logo.png',
  'http://0.0.0.0:8080/logo.png',
  'file:///etc/passwd',
  'gopher://93.184.216.34/x',
  'data:image/svg+xml,<svg/>',
  'not a url',
];

function payload(over: Partial<ReportPayloadDto> = {}): ReportPayloadDto {
  return {
    name: 'Monthly review',
    logoUrl: null,
    note: null,
    window: { from: '2026-10-01', to: '2026-10-31' },
    timezone: 'UTC',
    platforms: ['instagram'],
    channels: [{ id: 1, platform: 'instagram', name: 'Acme' }],
    compare: 'usual',
    chartMetric: 'reach',
    sections: ['totals'],
    generatedAt: '2026-11-01T00:00:00.000Z',
    overview: null,
    signals: null,
    audience: null,
    ...over,
  } as ReportPayloadDto;
}

function png(headers: Record<string, string> = {}) {
  return new Response(PNG, {
    status: 200,
    headers: { 'content-type': 'image/png', ...headers },
  });
}

/** Every string anywhere in `value`. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

let globalFetch: jest.SpyInstance;
beforeEach(() => {
  mockedFetch.mockReset();
  globalFetch = jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('unguarded global fetch was called'));
});
afterEach(() => jest.restoreAllMocks());

describe('inlineReportMedia: the logo', () => {
  it.each(PRIVATE_URLS)(
    'drops %s without any request, so it never reaches Chromium',
    async (url) => {
      const out = await inlineReportMedia(payload({ logoUrl: url }));
      expect(out.logoUrl).toBeNull();
      expect(strings(out)).not.toContain(url);
      expect(mockedFetch).not.toHaveBeenCalled();
      expect(globalFetch).not.toHaveBeenCalled();
    },
  );

  it('inlines a public PNG as a data: URI, fetched through the pinned agent', async () => {
    mockedFetch.mockResolvedValue(png());
    const out = await inlineReportMedia(payload({ logoUrl: PUBLIC_LOGO }));
    expect(out.logoUrl).toBe(PNG_DATA);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0] as [
      string,
      { dispatcher: unknown; redirect: string; signal: unknown },
    ];
    expect(url).toBe(PUBLIC_LOGO);
    expect(init.dispatcher).toBe(publicAgent);
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('keeps only the bare image type, not its parameters', async () => {
    mockedFetch.mockResolvedValue(
      png({ 'content-type': 'image/jpeg; charset=binary' }),
    );
    const out = await inlineReportMedia(payload({ logoUrl: PUBLIC_LOGO }));
    expect(out.logoUrl?.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it.each([
    'text/html',
    'image/svg+xml',
    'application/octet-stream',
    'video/mp4',
    '',
  ])('drops a public answer typed %j', async (type) => {
    const res = png();
    res.headers.set('content-type', type);
    if (!type) res.headers.delete('content-type');
    mockedFetch.mockResolvedValue(res);
    const out = await inlineReportMedia(payload({ logoUrl: PUBLIC_LOGO }));
    expect(out.logoUrl).toBeNull();
  });

  it('drops a non-2xx answer', async () => {
    mockedFetch.mockResolvedValue(new Response('nope', { status: 404 }));
    const out = await inlineReportMedia(payload({ logoUrl: PUBLIC_LOGO }));
    expect(out.logoUrl).toBeNull();
  });

  it('drops an image over the size cap (declared)', async () => {
    mockedFetch.mockResolvedValue(
      png({ 'content-length': String(REPORT_IMAGE_MAX_BYTES + 1) }),
    );
    const out = await inlineReportMedia(payload({ logoUrl: PUBLIC_LOGO }));
    expect(out.logoUrl).toBeNull();
  });

  it('drops an image over the size cap (streamed, no length)', async () => {
    const big = new Uint8Array(REPORT_IMAGE_MAX_BYTES + 1);
    mockedFetch.mockResolvedValue(
      new Response(big, { headers: { 'content-type': 'image/png' } }),
    );
    const out = await inlineReportMedia(payload({ logoUrl: PUBLIC_LOGO }));
    expect(out.logoUrl).toBeNull();
  });

  it('does not follow a redirect to a private address', async () => {
    mockedFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    );
    const out = await inlineReportMedia(payload({ logoUrl: PUBLIC_LOGO }));
    expect(out.logoUrl).toBeNull();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('drops the logo when the request fails', async () => {
    mockedFetch.mockRejectedValue(new TypeError('fetch failed'));
    const out = await inlineReportMedia(payload({ logoUrl: PUBLIC_LOGO }));
    expect(out.logoUrl).toBeNull();
  });

  it('gives up on a stalled image at the deadline', async () => {
    mockedFetch.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('timed out', 'TimeoutError')),
          ),
        ),
    );
    const out = await inlineReportMedia(payload({ logoUrl: PUBLIC_LOGO }), {
      deadlineMs: 20,
    });
    expect(out.logoUrl).toBeNull();
  });

  it('leaves a report with no logo alone and asks nothing', async () => {
    const input = payload();
    const out = await inlineReportMedia(input);
    expect(out).toEqual(input);
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

describe('inlineReportMedia: post thumbnails', () => {
  const lanePost = (thumbnailUrl: string | null) => ({
    postId: 'p',
    channelId: 1,
    thumbnailUrl,
  });

  it('inlines public images, drops private ones and videos, and fetches each URL once', async () => {
    const video = 'https://93.184.216.35/clip.mp4';
    mockedFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url === video
          ? new Response('v', { headers: { 'content-type': 'video/mp4' } })
          : png(),
      ),
    );
    const input = payload({
      overview: {
        series: [
          { date: '2026-10-01', posts: [lanePost(PUBLIC_LOGO)] },
          { date: '2026-10-02', posts: [lanePost(PUBLIC_LOGO)] },
          { date: '2026-10-03', posts: [lanePost('http://10.0.0.8/a.png')] },
          { date: '2026-10-04', posts: [lanePost(video), lanePost(null)] },
        ],
        standout: { top: [lanePost('http://169.254.169.254/x.png')] },
      } as unknown as ReportPayloadDto['overview'],
    });

    const out = await inlineReportMedia(input);
    const series = (
      out.overview as unknown as {
        series: { posts: { thumbnailUrl: string | null }[] }[];
        standout: { top: { thumbnailUrl: string | null }[] };
      }
    ).series;
    expect(series[0].posts[0].thumbnailUrl).toBe(PNG_DATA);
    expect(series[1].posts[0].thumbnailUrl).toBe(PNG_DATA);
    expect(series[2].posts[0].thumbnailUrl).toBeNull();
    expect(series[3].posts[0].thumbnailUrl).toBeNull();
    expect(series[3].posts[1].thumbnailUrl).toBeNull();

    // Nothing that is not a data: URI is left in any image field.
    for (const s of strings(out)) {
      expect(s).not.toMatch(/^(https?|file):/);
    }
    // One request for the repeated image, one for the video; none private.
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(globalFetch).not.toHaveBeenCalled();
    // The input is not mutated.
    expect(
      (input.overview as unknown as { series: { posts: unknown[] }[] })
        .series[0].posts[0],
    ).toEqual(lanePost(PUBLIC_LOGO));
  });

  it('leaves non-image text alone (names, notes, permalinks)', async () => {
    const input = payload({
      note: 'see https://example.com',
      overview: {
        standout: {
          top: [{ ...lanePost(null), permalink: 'https://example.com/p/1' }],
        },
      } as unknown as ReportPayloadDto['overview'],
    });
    const out = await inlineReportMedia(input);
    expect(out).toEqual(input);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('stops inlining once the total budget is spent', async () => {
    mockedFetch.mockImplementation(() => Promise.resolve(png()));
    const urls = Array.from(
      { length: 6 },
      (_, i) => `https://93.184.216.${i + 1}/a.png`,
    );
    const out = await inlineReportMedia(
      payload({
        overview: {
          series: [{ posts: urls.map(lanePost) }],
        } as unknown as ReportPayloadDto['overview'],
      }),
      { budgetBytes: PNG.byteLength * 2, concurrency: 1 },
    );
    const thumbs = (
      out.overview as unknown as {
        series: { posts: { thumbnailUrl: string | null }[] }[];
      }
    ).series[0].posts.map((p) => p.thumbnailUrl);
    expect(thumbs.filter((t) => t === PNG_DATA)).toHaveLength(2);
    expect(thumbs.filter((t) => t === null)).toHaveLength(4);
  });
});
