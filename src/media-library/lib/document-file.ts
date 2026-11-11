import { mediaTypeFromUpload, type UploadTypeHints } from './upload-type';

/**
 * Documents (PDF, PPT, PPTX, DOC, DOCX) live on Cloudflare R2, never on
 * Cloudinary (owner decision). Cloudinary answers HTTP 401 to anyone fetching
 * a PDF while the account's "Allow delivery of PDF and ZIP files" setting is
 * off, so a document stored there can be neither previewed nor published.
 *
 * The one upload route for a document is the R2 presign below, after which
 * the browser saves the stored file with `POST items` (type `document`).
 * Every Cloudinary path refuses a document with `DocumentNeedsR2Exception`.
 */
export const DOCUMENT_UPLOAD_ROUTE = 'POST /media/r2/presign-composer-document';

/**
 * Extensions of files that are not pictures or videos: Cloudinary would store
 * them as a PDF "image" or as a `raw` file, and the Library would type them
 * `document`. Wider than the five R2 takes on purpose: a spreadsheet or a ZIP
 * must not reach Cloudinary either, it is simply refused everywhere.
 */
const DOCUMENT_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'dot',
  'dotx',
  'ppt',
  'pptx',
  'pps',
  'ppsx',
  'pot',
  'potx',
  'xls',
  'xlsx',
  'csv',
  'txt',
  'rtf',
  'odt',
  'odp',
  'ods',
  'key',
  'pages',
  'numbers',
  'zip',
  'epub',
]);

/** Mime types of the same files, with or without parameters. */
const DOCUMENT_MIME =
  /^(application\/(pdf|x-pdf|msword|rtf|zip|x-zip-compressed|epub\+zip|vnd\.ms-|vnd\.openxmlformats-officedocument\.|vnd\.oasis\.opendocument\.|vnd\.apple\.)|text\/)/i;

/** `%PDF-` */
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
/** OLE compound file: DOC, PPT, XLS. */
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
/** ZIP local file header: DOCX, PPTX, XLSX, ZIP. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** The lower-case extension of a file name or URL path, without the dot. */
export function extensionOf(name: string | undefined): string {
  if (!name) return '';
  const clean = name.split(/[?#]/)[0];
  const slash = clean.lastIndexOf('/');
  const base = slash >= 0 ? clean.slice(slash + 1) : clean;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** True when the bytes start like a PDF, an Office file or a ZIP. */
export function hasDocumentMagic(head: Buffer | undefined): boolean {
  if (!head || head.length < 4) return false;
  return (
    head.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC) ||
    head.subarray(0, OLE_MAGIC.length).equals(OLE_MAGIC) ||
    head.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)
  );
}

/** What is known about a file before it is stored. */
export interface DocumentHints {
  mimeType?: string;
  /** A file name or a URL; only its extension is read. */
  name?: string;
  /** The first bytes of the file, when the server has them. */
  head?: Buffer;
}

/**
 * True when the file is a document by its mime type, its extension or its
 * first bytes. Any one is enough: a browser that reports no type, a renamed
 * file and a URL without an extension are each caught by another signal.
 */
export function looksLikeDocument(h: DocumentHints): boolean {
  if (h.mimeType && DOCUMENT_MIME.test(h.mimeType.trim())) return true;
  if (DOCUMENT_EXTENSIONS.has(extensionOf(h.name))) return true;
  return hasDocumentMagic(h.head);
}

/**
 * True when Cloudinary stored the upload as a document (a PDF image or a
 * `raw` file): the check after the fact, for a URL whose bytes the server
 * never sees.
 */
export function isStoredDocument(u: UploadTypeHints): boolean {
  return mediaTypeFromUpload(u) === 'document';
}

/**
 * True when a Cloudinary delivery URL shows a document: a `raw` resource, or
 * a file whose extension is a document's.
 */
export function isCloudinaryDocumentUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  if (path.includes('/raw/upload/')) return true;
  return DOCUMENT_EXTENSIONS.has(extensionOf(path));
}
