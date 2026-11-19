/**
 * What may be stored as Library media, decided by the file's own bytes.
 *
 * ## Why an allowlist and not another denylist
 *
 * `document-file.ts` already sniffs magic numbers, but it answers a different
 * question: *"is this a document?"* — so that a PDF never reaches Cloudinary,
 * which cannot serve one. It is a **denylist**, and a denylist's default is
 * "allow". A `.exe`, an `.svg` carrying a script, an `.html` page or a shell
 * script renamed `cat.jpg` are none of them documents, so every one of them
 * passed, and `upload/file` set no `fileFilter` at all.
 *
 * This module inverts the default: a file is stored only if its bytes say it
 * is one of the media types we publish.
 *
 * ## Why the bytes and not the declared type
 *
 * `file.mimetype` from a multipart upload is the *client's* claim, taken from
 * the filename, and a data URI's `data:image/png;base64,` prefix is simply a
 * string the caller wrote. Neither is evidence. These checks read the magic
 * numbers instead, which is what the file actually is.
 *
 * SVG deserves its own mention: it is XML, so it has **no magic number at
 * all**, and it is also the one image format that can execute script when
 * served inline. There is nothing to match it against — and because the
 * default is now deny, that absence is exactly what refuses it.
 *
 * ## Why these are hand-written
 *
 * `file-type` is the usual package for this, and it works correctly in
 * production (verified: JPEG and MP4 identified, an ELF binary reported as
 * `application/x-elf`, an SVG as unknown). It is ESM-only from v17, and Jest
 * runs CommonJS in a vm context that refuses a real `import()` without
 * `--experimental-vm-modules`. Making it testable needed either that flag
 * across the whole suite — 661 media-library tests — or a ts-jest `module`
 * override, which collides with this project's `resolvePackageJsonExports`
 * (TS5098). The package is small; its toolchain cost is not.
 *
 * Seven checks cover all the formats below and correctly refuse ELF, MZ,
 * PDF, SVG, HTML and ZIP, with no dependency and no build config to keep
 * working. `document-file.ts` reads magic numbers by hand in this same
 * directory, so this is the house style rather than an exception.
 */
import { UnsupportedMediaTypeException } from '@nestjs/common';

/**
 * How many leading bytes are enough to identify every allowed format.
 *
 * The longest read below is the ISO-BMFF brand at offsets 8-12; 64 covers it
 * with room for a container that pads its first box. Kept small on purpose:
 * callers pass a `subarray` of the upload, not a copy of it.
 */
export const SNIFF_BYTES = 64;

/** The media kinds the Library stores. */
export type AllowedMediaKind = 'image' | 'video';

export interface SniffedType {
  /** A short format name, for a message a person reads. */
  ext: string;
  /** The real registered mime type, not the extension's spelling. */
  mime: string;
  kind: AllowedMediaKind;
}

const ascii = (b: Buffer, from: number, to: number): string =>
  b.subarray(from, to).toString('latin1');

const startsWith = (b: Buffer, bytes: readonly number[]): boolean =>
  b.length >= bytes.length && bytes.every((v, i) => b[i] === v);

/**
 * The ISO base media file format brand, for the family that shares one
 * header: MP4, MOV, HEIC, AVIF, 3GP.
 *
 * All of them are `....ftyp<brand>` — the box size, then `ftyp` at offset 4,
 * then a four-character brand at 8. The brand is what separates a video from
 * an iPhone photo, so unlike the other checks this one does read it.
 */
function isoBrand(b: Buffer): string | undefined {
  if (ascii(b, 4, 8) !== 'ftyp') return undefined;
  return ascii(b, 8, 12).trim().toLowerCase();
}

/** Brands that mean a still image rather than a video. */
const ISO_IMAGE_BRANDS: Record<string, { ext: string; mime: string }> = {
  heic: { ext: 'heic', mime: 'image/heic' },
  heix: { ext: 'heic', mime: 'image/heic' },
  hevc: { ext: 'heic', mime: 'image/heic' },
  heim: { ext: 'heic', mime: 'image/heic' },
  heis: { ext: 'heic', mime: 'image/heic' },
  mif1: { ext: 'heif', mime: 'image/heif' },
  msf1: { ext: 'heif', mime: 'image/heif' },
  avif: { ext: 'avif', mime: 'image/avif' },
  avis: { ext: 'avif', mime: 'image/avif' },
};

/** Brands that mean QuickTime rather than MP4. */
const ISO_QUICKTIME_BRANDS = new Set(['qt']);

/**
 * What the bytes are, or `undefined` when nothing here recognises them.
 *
 * The allowed formats, and how each is identified:
 *
 * | Format | Signature |
 * |---|---|
 * | JPEG | `FF D8 FF` |
 * | PNG | `89 50 4E 47 0D 0A 1A 0A` |
 * | GIF | `GIF87a` / `GIF89a` |
 * | WebP | `RIFF` + `WEBP` at 8 |
 * | AVI | `RIFF` + `AVI ` at 8 |
 * | WebM / MKV | EBML `1A 45 DF A3` |
 * | MP4 / MOV / HEIC / AVIF | `ftyp` at 4, brand at 8 |
 * | MPEG-PS | `00 00 01 BA` |
 */
export function sniffMedia(head: Buffer | Uint8Array): SniffedType | undefined {
  const b = Buffer.isBuffer(head) ? head : Buffer.from(head);
  // Every signature above needs at least 12 bytes to be read; a shorter file
  // cannot be any of them.
  if (b.length < 12) return undefined;

  if (startsWith(b, [0xff, 0xd8, 0xff])) {
    return { ext: 'jpg', mime: 'image/jpeg', kind: 'image' };
  }
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { ext: 'png', mime: 'image/png', kind: 'image' };
  }
  const gif = ascii(b, 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') {
    return { ext: 'gif', mime: 'image/gif', kind: 'image' };
  }
  if (ascii(b, 0, 4) === 'RIFF') {
    // RIFF is a container: the type at offset 8 says which one. A RIFF that
    // is neither of these (a WAV, say) returns undefined and is refused.
    const riff = ascii(b, 8, 12);
    if (riff === 'WEBP') {
      return { ext: 'webp', mime: 'image/webp', kind: 'image' };
    }
    if (riff === 'AVI ') {
      return { ext: 'avi', mime: 'video/x-msvideo', kind: 'video' };
    }
    return undefined;
  }
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) {
    // EBML covers WebM and MKV alike; telling them apart needs the DocType
    // element, and both are allowed, so it is not read.
    return { ext: 'webm', mime: 'video/webm', kind: 'video' };
  }
  if (startsWith(b, [0x00, 0x00, 0x01, 0xba])) {
    return { ext: 'mpg', mime: 'video/mpeg', kind: 'video' };
  }

  const brand = isoBrand(b);
  if (brand !== undefined) {
    const image = ISO_IMAGE_BRANDS[brand];
    if (image) return { ...image, kind: 'image' };
    if (ISO_QUICKTIME_BRANDS.has(brand)) {
      return { ext: 'mov', mime: 'video/quicktime', kind: 'video' };
    }
    // Every other ISO-BMFF brand (isom, mp41, mp42, avc1, M4V, 3gp…) is a
    // video container. Allowed as MP4: Cloudinary decodes it and reports the
    // real format, which `storedFormatDisallowed` checks afterwards.
    return { ext: 'mp4', mime: 'video/mp4', kind: 'video' };
  }

  return undefined;
}

/** The formats above, for the message a refusal shows a person. */
const FRIENDLY = 'JPEG, PNG, GIF, WebP, HEIC, AVIF, MP4, MOV, WebM, AVI';

/**
 * Refuses bytes that are not an allowed media file.
 *
 * Deliberately refuses an unrecognised file too: the default is deny, so a
 * format nothing here knows is not stored. That is the point of the
 * inversion — an unknown file is exactly the case a denylist waved through.
 */
export function assertAllowedMedia(head: Buffer | Uint8Array): SniffedType {
  const found = sniffMedia(head);
  if (!found) {
    throw new UnsupportedMediaTypeException(
      `This file type is not supported. Allowed: ${FRIENDLY}.`,
    );
  }
  return found;
}

/**
 * True when the declared type contradicts the bytes, for logging only.
 *
 * Not a refusal: browsers send `application/octet-stream` for a perfectly
 * good JPEG often enough that refusing on a mismatch would break real
 * uploads. The bytes have already decided; a deliberate mismatch is still
 * worth seeing, because it is what an upload attack looks like.
 */
export function mimeDisagrees(
  declaredMime: string | undefined,
  sniffed: SniffedType,
): boolean {
  if (!declaredMime) return false;
  const bare = declaredMime.split(';')[0].trim().toLowerCase();
  if (!bare || bare === 'application/octet-stream') return false;
  if (bare === sniffed.mime) return false;
  // Aliases that honestly mean the same file.
  const aliases: Record<string, readonly string[]> = {
    'image/jpeg': ['image/jpg'],
    'image/heic': ['image/heif'],
    'image/heif': ['image/heic'],
    'video/quicktime': ['video/mov'],
    'video/x-msvideo': ['video/avi', 'video/msvideo'],
    'video/webm': ['video/x-matroska', 'video/mkv'],
    'video/mp4': ['video/m4v', 'video/x-m4v', 'video/3gpp'],
  };
  return !(aliases[sniffed.mime] ?? []).includes(bare);
}

/**
 * The formats Cloudinary may report for a stored upload, for the one path
 * where the server never holds the bytes.
 *
 * `ingestRemoteUrl` hands Cloudinary a URL and Cloudinary fetches it, so
 * there is nothing local to sniff. What there IS, afterwards, is Cloudinary's
 * own verdict: it decoded the file to store it, and reports the `format` it
 * found. That is byte-based evidence, just gathered by someone else — the
 * same reasoning `refuseStoredDocument` already uses for a PDF.
 *
 * Keyed by Cloudinary's `format` string, not by mime type.
 */
export const ALLOWED_STORED_FORMAT: ReadonlySet<string> = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'heic',
  'heif',
  'avif',
  'mp4',
  'mov',
  'webm',
  'avi',
  'mkv',
  'mpeg',
  'mpg',
  'm4v',
  '3gp',
  'ogv',
]);

/** True when a stored upload's format is not allowed Library media. */
export function storedFormatDisallowed(u: {
  format?: string;
  resourceType: 'image' | 'video' | 'raw';
}): boolean {
  // `raw` is anything Cloudinary could not decode as media; the document
  // check already refuses it, and so does this.
  if (u.resourceType === 'raw') return true;
  const format = u.format?.toLowerCase();
  // Nothing claimed: leave it to the checks that did see bytes, rather than
  // refuse an upload on an absent field.
  if (!format) return false;
  return !ALLOWED_STORED_FORMAT.has(format);
}
