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

import { Logger } from '@nestjs/common';
import { publicAgent } from '../../../common/net/public-fetch';
import type { ReportPayloadDto } from '../reports.dto';
import {
  inlineReportMedia,
  REPORT_IMAGE_BUDGET_BYTES,
  REPORT_IMAGE_MAX_BYTES,
  sniffImageType,
} from './inline-report-media';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DATA = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`;
const PUBLIC_LOGO = 'https://93.184.216.34/logo.png';

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** An ISO-BMFF `ftyp` box: size, 'ftyp', major brand, minor version, brands. */
function ftyp(major: string, ...compatible: string[]): number[] {
  return [
    0,
    0,
    0,
    16 + 4 * compatible.length,
    ...ascii('ftyp'),
    ...ascii(major),
    0,
    0,
    0,
    0,
    ...compatible.flatMap(ascii),
  ];
}

/** The first bytes of each type we inline. */
const MAGIC: Record<string, Uint8Array<ArrayBuffer>> = {
  'image/png': PNG,
  'image/jpeg': Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]),
  'image/gif': Uint8Array.from([...ascii('GIF89a'), 1, 0, 1, 0]),
  'image/webp': Uint8Array.from([
    ...ascii('RIFF'),
    0x24,
    0,
    0,
    0,
    ...ascii('WEBPVP8 '),
  ]),
  'image/avif': Uint8Array.from(ftyp('avif', 'mif1', 'miaf')),
};

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

/** A JPEG of `bytes` bytes: the JPEG signature, then zeros. */
function jpeg(bytes: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes);
  out.set(MAGIC['image/jpeg']);
  return out;
}

/** The length of the data: URI a body of `bytes` bytes becomes. */
const dataUriLength = (type: string, bytes: number) =>
  `data:${type};base64,`.length + Math.ceil(bytes / 3) * 4;

/** Every string anywhere in `value`. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

const lanePost = (thumbnailUrl: string | null) => ({
  postId: 'p',
  channelId: 1,
  thumbnailUrl,
});

/** The thumbnails of `overview.series[0].posts`, in order. */
function seriesThumbs(out: ReportPayloadDto): (string | null)[] {
  return (
    out.overview as unknown as {
      series: { posts: { thumbnailUrl: string | null }[] }[];
    }
  ).series[0].posts.map((p) => p.thumbnailUrl);
}

let globalFetch: jest.SpyInstance;
let warn: jest.SpyInstance;
let debug: jest.SpyInstance;
beforeEach(() => {
  mockedFetch.mockReset();
  globalFetch = jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('unguarded global fetch was called'));
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

const logged = () => debug.mock.calls.map((c: unknown[]) => String(c[0]));

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

  it.each(Object.entries(MAGIC))(
    'reads %s from the bytes, whatever the header says',
    async (type, bytes) => {
      for (const header of [
        'image/jpg',
        'application/octet-stream',
        'text/html',
        '',
      ]) {
        const res = new Response(bytes);
        if (header) res.headers.set('content-type', header);
        else res.headers.delete('content-type');
        mockedFetch.mockResolvedValueOnce(res);
        const out = await inlineReportMedia(payload({ logoUrl: PUBLIC_LOGO }));
        expect(out.logoUrl).toBe(
          `data:${type};base64,${Buffer.from(bytes).toString('base64')}`,
        );
      }
    },
  );

  it.each([
    ['HTML labelled image/png', ascii('<!doctype html><p>hi'), 'image/png'],
    ['SVG labelled image/png', ascii('<svg xmlns="x"/>'), 'image/png'],
    ['an MP4 labelled image/jpeg', ftyp('isom', 'mp41'), 'image/jpeg'],
    [
      'a HEIC photo (Chromium cannot draw it)',
      ftyp('heic', 'mif1'),
      'image/heic',
    ],
    ['an empty body', [], 'image/png'],
    ['a truncated PNG signature', [0x89, 0x50, 0x4e], 'image/png'],
  ])('drops %s', async (_what, bytes, header) => {
    mockedFetch.mockResolvedValue(
      new Response(Uint8Array.from(bytes), {
        headers: { 'content-type': header },
      }),
    );
    const out = await inlineReportMedia(payload({ logoUrl: PUBLIC_LOGO }));
    expect(out.logoUrl).toBeNull();
  });

  it('inlines a 9 MB phone photo: the cap is the 10 MB image upload cap', async () => {
    expect(REPORT_IMAGE_MAX_BYTES).toBe(10 * 1024 * 1024);
    const photo = jpeg(9 * 1024 * 1024);
    mockedFetch.mockResolvedValue(
      new Response(photo, { headers: { 'content-type': 'image/jpg' } }),
    );
    const out = await inlineReportMedia(payload({ logoUrl: PUBLIC_LOGO }));
    expect(out.logoUrl?.startsWith('data:image/jpeg;base64,/9j/')).toBe(true);
    expect(out.logoUrl).toHaveLength(
      dataUriLength('image/jpeg', photo.byteLength),
    );
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
    mockedFetch.mockResolvedValue(
      new Response(jpeg(REPORT_IMAGE_MAX_BYTES + 1)),
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
  it('inlines public images, drops private ones and videos, and fetches each URL once', async () => {
    const video = 'https://93.184.216.35/clip.mp4';
    mockedFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url === video
          ? new Response(Uint8Array.from(ftyp('isom', 'mp41')), {
              headers: { 'content-type': 'video/mp4' },
            })
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
});

describe('inlineReportMedia: the budget', () => {
  // The data URI each test image becomes: its length in the JSON.
  const COST = PNG_DATA.length;

  it('stops fetching once the budget is spent', async () => {
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
      { budgetBytes: COST * 2, concurrency: 1 },
    );
    expect(seriesThumbs(out)).toEqual([
      PNG_DATA,
      PNG_DATA,
      null,
      null,
      null,
      null,
    ]);
    // spent >= budget after two: the other four are never downloaded.
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(logged().filter((l) => l.includes('over_budget'))).toHaveLength(4);
  });

  it('charges a repeated image for every place it is written', async () => {
    mockedFetch.mockImplementation(() => Promise.resolve(png()));
    const thrice = (budgetBytes: number) =>
      inlineReportMedia(
        payload({
          overview: {
            series: [{ posts: [1, 2, 3].map(() => lanePost(PUBLIC_LOGO)) }],
          } as unknown as ReportPayloadDto['overview'],
        }),
        { budgetBytes },
      );

    expect(seriesThumbs(await thrice(COST * 3 - 1))).toEqual([
      null,
      null,
      null,
    ]);
    expect(seriesThumbs(await thrice(COST * 3))).toEqual([
      PNG_DATA,
      PNG_DATA,
      PNG_DATA,
    ]);
    // Fetched once per payload, however often it appears.
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('fits a full report of phone photos: a logo and 9 thumbnails at 4 MB', async () => {
    const photo = jpeg(4 * 1024 * 1024);
    mockedFetch.mockImplementation(() => Promise.resolve(new Response(photo)));
    const urls = Array.from(
      { length: 9 },
      (_, i) => `https://93.184.216.${i + 1}/p.jpg`,
    );
    const out = await inlineReportMedia(
      payload({
        logoUrl: PUBLIC_LOGO,
        overview: {
          standout: {
            above: urls.slice(0, 3).map(lanePost),
            below: urls.slice(3, 6).map(lanePost),
          },
          brief: { sources: urls.slice(6).map(lanePost) },
        } as unknown as ReportPayloadDto['overview'],
      }),
    );
    expect(
      strings(out).filter((s) => s.startsWith('data:image/jpeg')),
    ).toHaveLength(10);
    expect(REPORT_IMAGE_BUDGET_BYTES).toBeGreaterThanOrEqual(
      10 * dataUriLength('image/jpeg', photo.byteLength),
    );
  });
});

describe('inlineReportMedia: logging', () => {
  it('says unsafe for a refused URL, at debug level only', async () => {
    await inlineReportMedia(payload({ logoUrl: 'http://169.254.169.254/x' }));
    expect(logged()).toEqual([expect.stringContaining('unsafe')]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('says too_large for a declared oversize body', async () => {
    mockedFetch.mockResolvedValue(
      png({ 'content-length': String(REPORT_IMAGE_MAX_BYTES + 1) }),
    );
    await inlineReportMedia(payload({ logoUrl: PUBLIC_LOGO }));
    expect(logged()).toEqual([expect.stringContaining('too_large')]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('says too_large for a streamed oversize body', async () => {
    mockedFetch.mockResolvedValue(
      new Response(jpeg(REPORT_IMAGE_MAX_BYTES + 1)),
    );
    await inlineReportMedia(payload({ logoUrl: PUBLIC_LOGO }));
    expect(logged()).toEqual([expect.stringContaining('too_large')]);
  });

  it('names the other reasons, and never the URL', async () => {
    mockedFetch
      .mockResolvedValueOnce(new Response('<html>'))
      .mockResolvedValueOnce(new Response('x', { status: 404 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    for (let i = 0; i < 3; i++) {
      await inlineReportMedia(payload({ logoUrl: PUBLIC_LOGO }));
    }
    expect(logged()).toEqual([
      expect.stringContaining('not_image'),
      expect.stringContaining('http_404'),
      expect.stringContaining('network'),
    ]);
    for (const line of logged()) expect(line).not.toContain('93.184');
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs nothing for an image that was inlined', async () => {
    mockedFetch.mockResolvedValue(png());
    await inlineReportMedia(payload({ logoUrl: PUBLIC_LOGO }));
    expect(debug).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('inlineReportMedia: values that are not plain objects', () => {
  it('passes a Date (and other class instances) through untouched', async () => {
    mockedFetch.mockResolvedValue(png());
    const at = new Date('2026-11-01T00:00:00Z');
    const out = await inlineReportMedia({
      ...payload({ logoUrl: PUBLIC_LOGO }),
      overview: { at, nested: [{ at }] },
    } as unknown as ReportPayloadDto);
    const o = out.overview as unknown as { at: Date; nested: { at: Date }[] };
    expect(out.logoUrl).toBe(PNG_DATA);
    expect(o.at).toBe(at);
    expect(o.nested[0].at).toBe(at);
  });
});

describe('sniffImageType', () => {
  it('knows an AVIF by its major or a compatible brand; a HEIC is not one', () => {
    expect(sniffImageType(Buffer.from(ftyp('mif1', 'avif')))).toBe(
      'image/avif',
    );
    expect(sniffImageType(Buffer.from(ftyp('avis')))).toBe('image/avif');
    expect(sniffImageType(Buffer.from(ftyp('mif1', 'heic')))).toBeNull();
  });

  it('does not read past a short buffer', () => {
    expect(sniffImageType(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(sniffImageType(Buffer.from(ascii('RIFF')))).toBeNull();
    expect(
      sniffImageType(Buffer.from([0, 0, 0, 64, ...ascii('ftyp')])),
    ).toBeNull();
  });
});

describe('sniffImageType: bounded ftyp scan', () => {
  // Real headers: libavif's still image, and an iPhone HEIC.
  const LIBAVIF = [
    0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
    0x00, 0x00, 0x00, 0x00, 0x61, 0x76, 0x69, 0x66, 0x6d, 0x69, 0x66, 0x31,
    0x6d, 0x69, 0x61, 0x66, 0x00, 0x00, 0x00, 0xf2, 0x6d, 0x65, 0x74, 0x61,
  ];
  const IPHONE_HEIC = [
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    0x00, 0x00, 0x00, 0x00, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63,
    0x00, 0x00, 0x0f, 0xd2, 0x6d, 0x65, 0x74, 0x61,
  ];

  it('reads a real AVIF header, and a real HEIC header is not one', () => {
    expect(sniffImageType(Buffer.from(LIBAVIF))).toBe('image/avif');
    expect(sniffImageType(Buffer.from(IPHONE_HEIC))).toBeNull();
  });

  it('finds an AVIF brand within the first 64 bytes of a longer box', () => {
    const brands = ['mif1', 'miaf', 'MA1B', 'iso8', 'mif2', 'msf1', 'avif'];
    expect(16 + 4 * brands.length).toBeLessThanOrEqual(64);
    expect(sniffImageType(Buffer.from(ftyp('mif1', ...brands)))).toBe(
      'image/avif',
    );
  });

  it('stops at 64 bytes however large a box the file declares', () => {
    const huge = Buffer.alloc(10 * 1024 * 1024);
    huge.writeUInt32BE(0xffffffff, 0);
    huge.write('ftypmif1', 4, 'latin1');
    const reads = jest.spyOn(huge, 'toString');
    const started = performance.now();
    expect(sniffImageType(huge)).toBeNull();
    const elapsed = performance.now() - started;
    // Major brand plus compatible brands from 16 to 64: 13 reads at most.
    expect(reads.mock.calls.length).toBeLessThanOrEqual(13);
    expect(elapsed).toBeLessThan(50);
  });
});

describe('inlineReportMedia: the fail-closed sweep', () => {
  class TopPost {
    constructor(
      readonly postId: string,
      readonly thumbnailUrl: string | null,
    ) {}
  }

  it('nulls an image URL a class instance carries, and never fetches it', async () => {
    const input = {
      ...payload(),
      overview: {
        standout: { above: [new TopPost('p1', 'http://169.254.169.254/x')] },
        pinned: new TopPost('p2', 'https://93.184.216.34/a.png'),
      },
    } as unknown as ReportPayloadDto;
    const out = await inlineReportMedia(input);
    const o = out.overview as unknown as {
      standout: { above: TopPost[] };
      pinned: TopPost;
    };
    expect(o.standout.above[0].thumbnailUrl).toBeNull();
    expect(o.pinned.thumbnailUrl).toBeNull();
    expect(o.pinned.postId).toBe('p2');
    expect(strings(out)).not.toContain('https://93.184.216.34/a.png');
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('nulls an image field that is not a string, and keeps a data: image', async () => {
    mockedFetch.mockResolvedValue(png());
    const out = await inlineReportMedia({
      ...payload({ logoUrl: PUBLIC_LOGO }),
      overview: {
        a: [{ thumbnailUrl: { href: 'https://93.184.216.34/b.png' } }],
        b: [{ thumbnailUrl: 42 }],
        c: [{ thumbnailUrl: null }],
      },
    } as unknown as ReportPayloadDto);
    const o = out.overview as unknown as Record<
      string,
      { thumbnailUrl: unknown }[]
    >;
    expect(out.logoUrl).toBe(PNG_DATA);
    expect(o.a[0].thumbnailUrl).toBeNull();
    expect(o.b[0].thumbnailUrl).toBeNull();
    expect(o.c[0].thumbnailUrl).toBeNull();
  });
});
