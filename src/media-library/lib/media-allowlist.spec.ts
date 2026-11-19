import { UnsupportedMediaTypeException } from '@nestjs/common';
import {
  ALLOWED_STORED_FORMAT,
  assertAllowedMedia,
  mimeDisagrees,
  sniffMedia,
  SNIFF_BYTES,
  storedFormatDisallowed,
} from './media-allowlist';

/**
 * An upload is stored only if its bytes say it is media we publish.
 *
 * The check that existed before this was `document-file.ts`, which asks *"is
 * this a document?"* so that a PDF never reaches Cloudinary. That is a
 * DENYLIST, and its default is allow — so an executable, a script, an HTML
 * page or an SVG carrying `<script>` were none of them documents, and every
 * one of them was stored. `upload/file` set no `fileFilter` at all.
 *
 * These tests are written as the pair of questions that matter: is every
 * allowed format still accepted (or a real customer's upload breaks), and is
 * every dangerous one refused.
 */

/** Real file headers, byte for byte. */
const headers = {
  jpeg: Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0'),
    Buffer.alloc(8),
  ]),
  png: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from('IHDR'),
  ]),
  gif87: Buffer.concat([Buffer.from('GIF87a'), Buffer.alloc(8)]),
  gif89: Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(8)]),
  webp: riff('WEBP'),
  avi: riff('AVI '),
  webm: Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    Buffer.alloc(12),
  ]),
  mpeg: Buffer.concat([
    Buffer.from([0x00, 0x00, 0x01, 0xba]),
    Buffer.alloc(12),
  ]),
  mp4: iso('isom'),
  mp42: iso('mp42'),
  avc1: iso('avc1'),
  m4v: iso('M4V '),
  threegp: iso('3gp5'),
  mov: iso('qt  '),
  heic: iso('heic'),
  heif: iso('mif1'),
  avif: iso('avif'),
};

/** A RIFF container of the given type. */
function riff(type: string): Buffer {
  const b = Buffer.alloc(16);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(8, 4);
  b.write(type, 8, 'latin1');
  return b;
}

/** An ISO base media file with the given four-character brand. */
function iso(brand: string): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(32, 0);
  b.write('ftyp', 4, 'latin1');
  b.write(brand, 8, 'latin1');
  b.write(brand, 16, 'latin1');
  return b;
}

describe('every allowed format is recognised', () => {
  it.each([
    ['JPEG', headers.jpeg, 'image/jpeg', 'image'],
    ['PNG', headers.png, 'image/png', 'image'],
    ['GIF87a', headers.gif87, 'image/gif', 'image'],
    ['GIF89a', headers.gif89, 'image/gif', 'image'],
    ['WebP', headers.webp, 'image/webp', 'image'],
    ['HEIC', headers.heic, 'image/heic', 'image'],
    ['HEIF', headers.heif, 'image/heif', 'image'],
    ['AVIF', headers.avif, 'image/avif', 'image'],
    ['MP4 (isom)', headers.mp4, 'video/mp4', 'video'],
    ['MP4 (mp42)', headers.mp42, 'video/mp4', 'video'],
    ['MP4 (avc1)', headers.avc1, 'video/mp4', 'video'],
    ['M4V', headers.m4v, 'video/mp4', 'video'],
    ['3GP', headers.threegp, 'video/mp4', 'video'],
    ['MOV', headers.mov, 'video/quicktime', 'video'],
    ['WebM', headers.webm, 'video/webm', 'video'],
    ['AVI', headers.avi, 'video/x-msvideo', 'video'],
    ['MPEG', headers.mpeg, 'video/mpeg', 'video'],
  ])('%s', (_label, head, mime, kind) => {
    expect(sniffMedia(head)).toEqual(expect.objectContaining({ mime, kind }));
  });

  it('accepts every one of them through assertAllowedMedia', () => {
    for (const head of Object.values(headers)) {
      expect(() => assertAllowedMedia(head)).not.toThrow();
    }
  });
});

describe('what the denylist used to wave through', () => {
  /**
   * The point of the inversion. None of these is a document, so
   * `looksLikeDocument` answered false for each and the upload was stored.
   */
  it.each([
    // ELF: a Linux binary.
    [
      'an ELF binary',
      Buffer.concat([
        Buffer.from([0x7f]),
        Buffer.from('ELF'),
        Buffer.alloc(12),
      ]),
    ],
    // MZ: a Windows executable or DLL.
    [
      'a Windows executable',
      Buffer.concat([Buffer.from('MZ'), Buffer.alloc(32)]),
    ],
    // The one image format that can run script when served inline, and the
    // reason an extension check is not enough: it has NO magic number, so
    // there is nothing to match - only a deny-by-default refuses it.
    [
      'an SVG with a script',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ),
    ],
    [
      'an HTML page',
      Buffer.from('<!DOCTYPE html><html><body>hi</body></html>'),
    ],
    ['a shell script', Buffer.from('#!/bin/sh\nrm -rf /\n')],
    ['a Windows batch file', Buffer.from('@echo off\r\ndel /f /q C:\\*\r\n')],
    ['a PHP file', Buffer.from('<?php system($_GET["c"]); ?>          ')],
    // Already refused by the document denylist, and refused here too: a file
    // must pass BOTH, so neither check relies on the other.
    ['a PDF', Buffer.from('%PDF-1.7\n%%EOF\n')],
    [
      'a ZIP (and so DOCX/XLSX)',
      Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(12)]),
    ],
    // A RIFF that is not WebP or AVI: the container matches, the type does
    // not, and a check that stopped at `RIFF` would have stored it.
    ['a WAV', riff('WAVE')],
  ])('refuses %s', (_label, head) => {
    expect(sniffMedia(head)).toBeUndefined();
    expect(() => assertAllowedMedia(head)).toThrow(
      UnsupportedMediaTypeException,
    );
  });

  it('refuses a file renamed to look like a picture', () => {
    // The whole reason the bytes are read rather than the name or the
    // client's mime type: both of these say "a PNG", the bytes say ELF.
    const renamed = Buffer.concat([
      Buffer.from([0x7f]),
      Buffer.from('ELF'),
      Buffer.alloc(12),
    ]);
    expect(() => assertAllowedMedia(renamed)).toThrow(
      UnsupportedMediaTypeException,
    );
  });

  it('refuses bytes too short to identify', () => {
    expect(sniffMedia(Buffer.from([0xff, 0xd8, 0xff]))).toBeUndefined();
  });

  it('refuses an empty upload', () => {
    expect(sniffMedia(Buffer.alloc(0))).toBeUndefined();
  });

  it('names the sniffed type in the refusal, not the declared one', () => {
    // Saying "image/png is not supported" about an executable would be a lie,
    // and the mismatch is the interesting part of the event.
    try {
      assertAllowedMedia(Buffer.from('<!DOCTYPE html><html></html>'));
      fail('should have thrown');
    } catch (error) {
      expect((error as Error).message).toMatch(/not supported/);
      expect((error as Error).message).not.toMatch(/image\/png/);
    }
  });
});

describe('SNIFF_BYTES is enough for every signature', () => {
  /**
   * 16 was not: the ISO-BMFF brand sits at offsets 8-12 with the compatible
   * brands after it, so an MP4 truncated to 16 bytes still identifies, but
   * `base64Head` used to decode only 12 bytes, which does not.
   */
  it('identifies each format from only the first SNIFF_BYTES', () => {
    for (const [label, head] of Object.entries(headers)) {
      const truncated = head.subarray(0, SNIFF_BYTES);
      expect({ label, found: Boolean(sniffMedia(truncated)) }).toEqual({
        label,
        found: true,
      });
    }
  });

  it('is at least as long as the longest offset read', () => {
    // `ftyp` brand at 8-12, compatible brands from 16.
    expect(SNIFF_BYTES).toBeGreaterThanOrEqual(32);
  });
});

describe('a declared type that disagrees with the bytes', () => {
  const png = sniffMedia(headers.png)!;
  const mov = sniffMedia(headers.mov)!;

  it('is not reported when they agree', () => {
    expect(mimeDisagrees('image/png', png)).toBe(false);
  });

  it('ignores charset and other parameters', () => {
    expect(mimeDisagrees('IMAGE/PNG; charset=binary', png)).toBe(false);
  });

  it.each([
    ['application/octet-stream', png],
    ['image/jpg', sniffMedia(headers.jpeg)!],
    ['video/mov', mov],
    ['video/avi', sniffMedia(headers.avi)!],
    ['image/heif', sniffMedia(headers.heic)!],
  ])('forgives %s, which honestly means the same file', (declared, found) => {
    // A browser sending `application/octet-stream` for a good JPEG is common
    // enough that treating it as a disagreement would be noise.
    expect(mimeDisagrees(declared, found)).toBe(false);
  });

  it('is reported for a real contradiction', () => {
    expect(mimeDisagrees('image/png', mov)).toBe(true);
  });

  it('is not reported when nothing was declared', () => {
    expect(mimeDisagrees(undefined, png)).toBe(false);
  });
});

describe('the stored-format check, for a URL whose bytes we never see', () => {
  /**
   * `ingestRemoteUrl` hands Cloudinary a URL, so there is nothing local to
   * sniff. Cloudinary decoded the file to store it, and its `format` is
   * byte-based evidence gathered by someone else — the same reasoning
   * `refuseStoredDocument` already uses for a PDF.
   */
  it.each([
    ['jpg', 'image'],
    ['png', 'image'],
    ['gif', 'image'],
    ['webp', 'image'],
    ['heic', 'image'],
    ['mp4', 'video'],
    ['mov', 'video'],
    ['webm', 'video'],
  ])('allows a stored %s', (format, resourceType) => {
    expect(
      storedFormatDisallowed({
        format,
        resourceType: resourceType as 'image' | 'video',
      }),
    ).toBe(false);
  });

  it.each([['exe'], ['svg'], ['html'], ['zip'], ['txt'], ['psd']])(
    'refuses a stored %s',
    (format) => {
      expect(storedFormatDisallowed({ format, resourceType: 'image' })).toBe(
        true,
      );
    },
  );

  it('refuses a raw resource whatever its format', () => {
    // `raw` is anything Cloudinary could not decode as media.
    expect(storedFormatDisallowed({ format: 'jpg', resourceType: 'raw' })).toBe(
      true,
    );
  });

  it('allows an upload that claims no format', () => {
    // Rather than refuse on an absent field: the paths that did see bytes
    // have already checked them.
    expect(storedFormatDisallowed({ resourceType: 'image' })).toBe(false);
  });

  it('every sniffable format has a stored counterpart', () => {
    // Otherwise a file could pass the byte check on upload and be deleted
    // again by the stored check, which would be a maddening bug to chase.
    for (const head of Object.values(headers)) {
      const found = sniffMedia(head)!;
      expect({
        ext: found.ext,
        stored: ALLOWED_STORED_FORMAT.has(found.ext),
      }).toEqual({ ext: found.ext, stored: true });
    }
  });
});
