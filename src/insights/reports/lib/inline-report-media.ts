import { Logger } from '@nestjs/common';
import {
  fetchPublicMedia,
  isPrivateAddressRefusal,
  UnsafeMediaUrlError,
} from '../../../common/net/public-fetch';
import type { ReportPayloadDto } from '../reports.dto';

// The PDF is printed by Gotenberg's Chromium, which runs inside our network.
// Every image the print page draws would be fetched from there, and the
// logo (a Library item's `file_url`) and post thumbnails (draft media URLs)
// are user-supplied. So the render payload carries no image URL at all: we
// fetch each one ourselves through the SSRF guard and hand Chromium a data:
// URI, or null (the page then draws its fallback tile).
//
// The type check below is hand-rolled on purpose: five fixed signatures,
// and no image-sniffing package is a dependency here.

/**
 * An image post's thumbnail is usually the original upload, so the cap is
 * the R2 image upload cap (cloudflare-r2.service.ts, `image: 10 MB`).
 */
export const REPORT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/**
 * The data: URIs of one payload together, in the bytes they add to the JSON
 * (base64, so 4/3 of the image, and once per place an image is written). A
 * report draws a logo, at most 6 Stood out posts and a few brief sources:
 * 64 MB fits ten 4 MB phone photos (~5.6 MB each as base64). Past it, the
 * remaining images are not downloaded and print as the fallback tile.
 */
export const REPORT_IMAGE_BUDGET_BYTES = 64 * 1024 * 1024;
/** Chromium waits on this payload inside Gotenberg's 30 s; leave it room. */
export const REPORT_IMAGE_DEADLINE_MS = 8_000;
const REPORT_IMAGE_CONCURRENCY = 6;

/** Keys whose string value is an image URL the print page loads. */
const IMAGE_KEYS = new Set(['logoUrl', 'thumbnailUrl']);

export interface InlineReportMediaOptions {
  deadlineMs?: number;
  maxBytes?: number;
  budgetBytes?: number;
  concurrency?: number;
}

export type ReportImageType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'image/avif';

/** Why an image was left out; logged, never the URL (it is the user's). */
type DropReason =
  | 'unsafe'
  | 'too_large'
  | 'not_image'
  | `http_${number}`
  | 'over_budget'
  | 'deadline'
  | 'network';

const logger = new Logger('ReportMedia');

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const startsWith = (b: Buffer, sig: readonly number[], at = 0) =>
  b.length >= at + sig.length && sig.every((byte, i) => b[at + i] === byte);

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIG = [0xff, 0xd8, 0xff];
const GIF87 = ascii('GIF87a');
const GIF89 = ascii('GIF89a');
const RIFF = ascii('RIFF');
const WEBP = ascii('WEBP');
const FTYP = ascii('ftyp');
const AVIF_BRANDS = new Set(['avif', 'avis']);

/** True when an ISO-BMFF `ftyp` box names an AVIF brand (major or compatible). */
function isAvif(b: Buffer): boolean {
  if (b.length < 16 || !startsWith(b, FTYP, 4)) return false;
  const boxEnd = Math.min(b.readUInt32BE(0), b.length);
  // Major brand at 8, minor version at 12, compatible brands from 16.
  for (let at = 8; at + 4 <= boxEnd; at += at === 8 ? 8 : 4) {
    if (AVIF_BRANDS.has(b.toString('latin1', at, at + 4))) return true;
  }
  return false;
}

/**
 * The image type the bytes say, or null for anything Chromium should not be
 * handed as an image (SVG, HEIC, video, HTML...). The Content-Type header is
 * not consulted: R2 serves `application/octet-stream` and `image/jpg`.
 */
export function sniffImageType(b: Buffer): ReportImageType | null {
  if (startsWith(b, PNG_SIG)) return 'image/png';
  if (startsWith(b, JPEG_SIG)) return 'image/jpeg';
  if (startsWith(b, GIF87) || startsWith(b, GIF89)) return 'image/gif';
  if (startsWith(b, RIFF) && startsWith(b, WEBP, 8)) return 'image/webp';
  if (isAvif(b)) return 'image/avif';
  return null;
}

/** Arrays and plain objects are walked; a Date or any class instance is not. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** How many times each image URL is written in `value`. */
function collect(value: unknown, into: Map<string, number>): void {
  if (Array.isArray(value)) {
    for (const v of value) collect(v, into);
  } else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (IMAGE_KEYS.has(k) && typeof v === 'string') {
        into.set(v, (into.get(v) ?? 0) + 1);
      } else collect(v, into);
    }
  }
}

function replace(value: unknown, inlined: Map<string, string | null>): unknown {
  if (Array.isArray(value)) return value.map((v) => replace(v, inlined));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      IMAGE_KEYS.has(k) && typeof v === 'string'
        ? (inlined.get(v) ?? null)
        : replace(v, inlined),
    ]),
  );
}

/** The reason for a thrown download, from the guard's own error fields. */
function reasonOf(e: unknown): DropReason {
  // A streamed body over the cap may come back wrapped by the body reader.
  const cause = (e as { cause?: unknown } | null)?.cause;
  if (e instanceof UnsafeMediaUrlError) return e.reason;
  if (cause instanceof UnsafeMediaUrlError) return cause.reason;
  if (isPrivateAddressRefusal(e)) return 'unsafe';
  const name = (e as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'deadline';
  return 'network';
}

/** The image as a data: URI, or the reason it is left out. */
async function download(
  url: string,
  signal: AbortSignal,
  maxBytes: number,
): Promise<{ data: string } | { drop: DropReason }> {
  // Only http(s) is ever fetched; fetchPublicMedia refuses the rest (and
  // private literals) before any request, and caps the body at `maxBytes`.
  const res = await fetchPublicMedia(url, { signal, maxBytes });
  if (!res.ok) {
    void res.body?.cancel().catch(() => undefined);
    return { drop: `http_${res.status}` };
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const type = sniffImageType(bytes);
  if (!type) return { drop: 'not_image' };
  return { data: `data:${type};base64,${bytes.toString('base64')}` };
}

/**
 * A copy of `payload` whose `logoUrl` and every `thumbnailUrl` is a data: URI
 * of the image (fetched through the SSRF guard: http(s), public addresses
 * only, pinned; at most 10 MB; a png, jpeg, gif, webp or avif by its bytes)
 * or null. Each URL is fetched once. Never throws; each image left out is
 * logged at debug level with its reason.
 */
export async function inlineReportMedia(
  payload: ReportPayloadDto,
  opts: InlineReportMediaOptions = {},
): Promise<ReportPayloadDto> {
  const uses = new Map<string, number>();
  collect(payload, uses);
  if (!uses.size) return payload;

  const maxBytes = opts.maxBytes ?? REPORT_IMAGE_MAX_BYTES;
  const budget = opts.budgetBytes ?? REPORT_IMAGE_BUDGET_BYTES;
  const signal = AbortSignal.timeout(
    opts.deadlineMs ?? REPORT_IMAGE_DEADLINE_MS,
  );
  const queue = [...uses.keys()];
  const inlined = new Map<string, string | null>();
  let spent = 0;

  const inlineOne = async (
    url: string,
  ): Promise<{ data: string } | { drop: DropReason }> => {
    if (spent >= budget) return { drop: 'over_budget' };
    if (signal.aborted) return { drop: 'deadline' };
    let got: { data: string } | { drop: DropReason };
    try {
      got = await download(url, signal, maxBytes);
    } catch (e) {
      return { drop: reasonOf(e) };
    }
    if ('drop' in got) return got;
    // Written once per use: that is what it adds to the JSON.
    const cost = got.data.length * (uses.get(url) ?? 1);
    if (spent + cost > budget) return { drop: 'over_budget' };
    spent += cost;
    return got;
  };

  const worker = async (): Promise<void> => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      const result = await inlineOne(url);
      if ('data' in result) {
        inlined.set(url, result.data);
      } else {
        inlined.set(url, null);
        logger.debug(`Report image left out: ${result.drop}`);
      }
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          opts.concurrency ?? REPORT_IMAGE_CONCURRENCY,
          uses.size,
        ),
      },
      worker,
    ),
  );
  return replace(payload, inlined) as ReportPayloadDto;
}
