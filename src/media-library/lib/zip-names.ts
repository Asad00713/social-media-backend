import { extname } from 'path';

/** Characters no common file system or unzip tool accepts in a name. */
// eslint-disable-next-line no-control-regex -- control characters are unsafe in file names too
const UNSAFE_CHARS = /[/\\:*?"<>|\x00-\x1f]/g;

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'application/pdf': '.pdf',
};

const PLAUSIBLE_EXT = /^\.[a-z0-9]{1,10}$/;
const FALLBACK_NAME = 'file';

export interface ZipNameSource {
  name: string;
  mimeType: string | null;
  fileUrl: string;
}

/** Replaces characters a zip entry or an extracted file can't carry. */
export function sanitizeFileName(name: string): string {
  const safe = name.replace(UNSAFE_CHARS, '_').trim();
  // yazl rejects an empty name and a `..` segment; a bare dot name is useless.
  return /^\.*$/.test(safe) ? FALLBACK_NAME : safe;
}

function extensionOf(item: ZipNameSource): string {
  const byMime = item.mimeType ? EXT_BY_MIME[item.mimeType] : undefined;
  if (byMime) return byMime;
  try {
    const ext = extname(new URL(item.fileUrl).pathname).toLowerCase();
    return PLAUSIBLE_EXT.test(ext) ? ext : '';
  } catch {
    return '';
  }
}

/**
 * One unique entry name per item, in order: unsafe characters become `_`, the
 * file's extension is appended unless the name already ends with it, and a
 * later duplicate becomes `Name (2).ext`, `Name (3).ext`, … Names compare
 * case-insensitively, because the zip may be extracted on a case-insensitive
 * file system.
 */
export function zipEntryNames(items: ZipNameSource[]): string[] {
  const taken = new Set<string>();
  return items.map((item) => {
    const base = sanitizeFileName(item.name);
    const ext = extensionOf(item);
    const hasExt = ext !== '' && base.toLowerCase().endsWith(ext);
    const full = hasExt || ext === '' ? base : `${base}${ext}`;

    let name = full;
    if (taken.has(name.toLowerCase())) {
      const suffix = ext !== '' ? ext : extname(full);
      const stem = suffix ? full.slice(0, -suffix.length) : full;
      for (let n = 2; taken.has(name.toLowerCase()); n++) {
        name = `${stem} (${n})${suffix}`;
      }
    }
    taken.add(name.toLowerCase());
    return name;
  });
}
