/**
 * Folder kinds: one per Library tab. Migration 0054 merged the legacy
 * image / video / gif / document folders into 'media'.
 */
export const FOLDER_KINDS = [
  'media',
  'template',
  'text_snippet',
  'link',
] as const;
export type FolderKind = (typeof FOLDER_KINDS)[number];

/** What a media item can be. Items keep their own type; folders do not. */
export const MEDIA_ITEM_TYPES = ['image', 'video', 'gif', 'document'] as const;
export type MediaType = (typeof MEDIA_ITEM_TYPES)[number];

/**
 * Legacy request values (image|video|gif|document) become 'media'. Anything
 * else passes through untouched so the validator can reject it.
 */
export function normalizeFolderKind(input: unknown): unknown {
  return (MEDIA_ITEM_TYPES as readonly unknown[]).includes(input)
    ? 'media'
    : input;
}

/** The legacy snippet type 'bio' is now 'signature'. */
export function normalizeSnippetType(input: unknown): unknown {
  return input === 'bio' ? 'signature' : input;
}
