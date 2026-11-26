import { Logger } from '@nestjs/common';
import { fetchPublicMedia } from '../../../common/net/public-fetch';
import type { ReportPayloadDto } from '../reports.dto';

// The PDF is printed by Gotenberg's Chromium, which runs inside our network.
// Every image the print page draws would be fetched from there, and the
// logo (a Library item's `file_url`) and post thumbnails (draft media URLs)
// are user-supplied. So the render payload carries no image URL at all: we
// fetch each one ourselves through the SSRF guard and hand Chromium a data:
// URI, or null (the page then draws its fallback tile).

/** A logo or thumbnail is drawn at a few dozen px; 2 MB is plenty. */
export const REPORT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** All the inlined images of one payload together. */
export const REPORT_IMAGE_BUDGET_BYTES = 24 * 1024 * 1024;
/** Chromium waits on this payload inside Gotenberg's 30 s; leave it room. */
export const REPORT_IMAGE_DEADLINE_MS = 8_000;
const REPORT_IMAGE_CONCURRENCY = 6;

/** Raster types only: no SVG, no video. Video thumbnails become null. */
const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

/** Keys whose string value is an image URL the print page loads. */
const IMAGE_KEYS = new Set(['logoUrl', 'thumbnailUrl']);

export interface InlineReportMediaOptions {
  deadlineMs?: number;
  maxBytes?: number;
  budgetBytes?: number;
  concurrency?: number;
}

const logger = new Logger('ReportMedia');

function collect(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collect(v, into);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (IMAGE_KEYS.has(k) && typeof v === 'string') into.add(v);
      else collect(v, into);
    }
  }
}

function replace(value: unknown, inlined: Map<string, string | null>): unknown {
  if (Array.isArray(value)) return value.map((v) => replace(v, inlined));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        IMAGE_KEYS.has(k) && typeof v === 'string'
          ? (inlined.get(v) ?? null)
          : replace(v, inlined),
      ]),
    );
  }
  return value;
}

/** The image as bytes and type, or null for anything we would not draw. */
async function download(
  url: string,
  signal: AbortSignal,
  maxBytes: number,
): Promise<{ type: string; bytes: Buffer } | null> {
  // Only http(s) is ever fetched; fetchPublicMedia refuses the rest (and
  // private literals) before any request.
  const res = await fetchPublicMedia(url, { signal, maxBytes });
  if (!res.ok) {
    void res.body?.cancel().catch(() => undefined);
    return null;
  }
  const type = (res.headers.get('content-type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!IMAGE_TYPES.has(type)) {
    void res.body?.cancel().catch(() => undefined);
    return null;
  }
  return { type, bytes: Buffer.from(await res.arrayBuffer()) };
}

/**
 * A copy of `payload` whose `logoUrl` and every `thumbnailUrl` is a data: URI
 * of the image (fetched through the SSRF guard: http(s), public addresses
 * only, pinned, at most 2 MB, a raster image type) or null. Never throws.
 */
export async function inlineReportMedia(
  payload: ReportPayloadDto,
  opts: InlineReportMediaOptions = {},
): Promise<ReportPayloadDto> {
  const urls = new Set<string>();
  collect(payload, urls);
  if (!urls.size) return payload;

  const maxBytes = opts.maxBytes ?? REPORT_IMAGE_MAX_BYTES;
  const budget = opts.budgetBytes ?? REPORT_IMAGE_BUDGET_BYTES;
  const signal = AbortSignal.timeout(
    opts.deadlineMs ?? REPORT_IMAGE_DEADLINE_MS,
  );
  const queue = [...urls];
  const inlined = new Map<string, string | null>();
  let spent = 0;

  const worker = async (): Promise<void> => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      let data: string | null = null;
      try {
        const image = signal.aborted
          ? null
          : await download(url, signal, maxBytes);
        if (image && spent + image.bytes.byteLength <= budget) {
          spent += image.bytes.byteLength;
          data = `data:${image.type};base64,${image.bytes.toString('base64')}`;
        }
      } catch (e) {
        // The URL is the user's own; the reason is enough to debug with.
        logger.warn(
          `Report image dropped: ${e instanceof Error ? e.name : 'error'}`,
        );
      }
      inlined.set(url, data);
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          opts.concurrency ?? REPORT_IMAGE_CONCURRENCY,
          urls.size,
        ),
      },
      worker,
    ),
  );
  return replace(payload, inlined) as ReportPayloadDto;
}
