import { z } from 'zod';
import type { AgentToolDefinition, ToolContext } from '../maestro.types';
import {
  REFERENCE_USAGE_HINT,
  withReferences,
  type EntityReference,
} from './references';

/**
 * The workspace's OWN library — what the user has saved, as opposed to the
 * stock photo search in media.tools.ts.
 *
 * Those two are easy to confuse and the cost of confusing them is high: offering
 * a stranger's stock photo when the user asked for their own logo is a wrong
 * answer that looks like a right one. The distinction is stated in both tool
 * descriptions rather than the system prompt alone, because the description is
 * what the model reads while choosing.
 *
 * One search tool with a `kind` discriminator, not five. There are already 38
 * tools; five more near-identical `list_*` names would make the pick harder
 * exactly where the names collide. The same reasoning that replaced free-form
 * dates with a `period` enum in planner.tools.ts: give the model one obvious
 * door with a labelled switch, not five doors that look alike.
 */

/**
 * What the user can ask for, in the words the Library screen itself uses.
 *
 * These map onto the backend's MEDIA_LIBRARY_TYPES, except that `media` fans out
 * to the three visual types. A user asking for "my images" does not think of
 * gifs as a separate kingdom, and asking them to pick would be an interrogation.
 */
export const LIBRARY_KINDS = [
  'media',
  'image',
  'video',
  'gif',
  'document',
  'template',
  'snippet',
  'link',
  'folder',
] as const;

export type LibraryKind = (typeof LIBRARY_KINDS)[number];

/** Which service answers a given kind. */
type Source = 'items' | 'templates' | 'snippets' | 'links' | 'categories';

const SOURCE_BY_KIND: Record<LibraryKind, Source> = {
  media: 'items',
  image: 'items',
  video: 'items',
  gif: 'items',
  document: 'items',
  template: 'templates',
  snippet: 'snippets',
  link: 'links',
  folder: 'categories',
};

/** The item-table `type` filter a kind implies, if it narrows to one. */
const ITEM_TYPE_BY_KIND: Partial<Record<LibraryKind, string>> = {
  image: 'image',
  video: 'video',
  gif: 'gif',
  document: 'document',
};

/**
 * Where the Library page opens for a kind.
 *
 * The Library has no per-item route — it is one screen driven by `?section=`.
 * So a chip lands on the right SHELF rather than the exact item. That is a real
 * limitation, and naming it here keeps the next reader from assuming the id is
 * being honoured.
 */
const SECTION_BY_KIND: Record<LibraryKind, string> = {
  media: 'type-image',
  image: 'type-image',
  video: 'type-video',
  gif: 'type-gif',
  document: 'type-document',
  template: 'type-template',
  snippet: 'type-text_snippet',
  link: 'type-link',
  folder: 'folders',
};

/** How many rows one answer can name before it stops being an answer. */
const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 40;

/** A row as every library service returns it — only the fields read here. */
interface LibraryRow {
  id: string;
  name: string;
  type?: string | null;
  templateType?: string | null;
  snippetType?: string | null;
  description?: string | null;
  fileUrl?: string | null;
  thumbnailUrl?: string | null;
  url?: string | null;
  content?: unknown;
  tags?: string[] | null;
  isStarred?: boolean | null;
  usageCount?: number | null;
  lastUsedAt?: Date | null;
  createdAt?: Date | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  fileSize?: number | null;
  platforms?: string[] | null;
  category?: { id: string; name: string } | null;
}

interface Listed {
  items: LibraryRow[];
  total: number;
}

/** The library services this tool set reads. Structural, so tests can fake them. */
export interface LibraryDeps {
  items: {
    findAll(
      workspaceId: string,
      query: Record<string, unknown>,
    ): Promise<Listed>;
    findOne(workspaceId: string, id: string): Promise<LibraryRow | null>;
  };
  templates: {
    findAll(
      workspaceId: string,
      query: Record<string, unknown>,
    ): Promise<Listed>;
    findOne(workspaceId: string, id: string): Promise<LibraryRow | null>;
  };
  snippets: {
    findAll(
      workspaceId: string,
      query: Record<string, unknown>,
    ): Promise<Listed>;
    findOne(workspaceId: string, id: string): Promise<LibraryRow | null>;
  };
  links: {
    findAll(
      workspaceId: string,
      query: Record<string, unknown>,
    ): Promise<Listed>;
    findOne(workspaceId: string, id: string): Promise<LibraryRow | null>;
  };
  categories: {
    findAll(
      workspaceId: string,
      query?: Record<string, unknown>,
    ): Promise<unknown>;
  };
}

/** Bytes as something a person would say out loud. */
function humanSize(bytes: number | null | undefined): string | null {
  if (typeof bytes !== 'number' || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** A date the model can read aloud without doing arithmetic on it. */
function humanDate(at: Date | null | undefined): string | null {
  if (!at) return null;
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * The sub-type worth saying, when the kind alone does not carry it.
 *
 * A template is a "carousel" or a "story"; a snippet is "hashtags" or a "CTA".
 * Those distinctions are the reason the user saved the thing separately, so
 * dropping them would flatten the library into an undifferentiated pile.
 */
function subtypeOf(row: LibraryRow): string | null {
  return row.templateType ?? row.snippetType ?? row.type ?? null;
}

function chipFor(row: LibraryRow, kind: LibraryKind): EntityReference {
  return {
    kind: 'media',
    id: row.id,
    label: row.name,
    // The shelf, not the item — see SECTION_BY_KIND. Carried as status so the
    // chip reads "Logo · template" and the user knows where it lives.
    status: subtypeOf(row) ?? kind,
  };
}

/** One row, trimmed to what an answer actually uses. */
function summarize(row: LibraryRow, kind: LibraryKind) {
  return {
    id: row.id,
    name: row.name,
    kind: SOURCE_BY_KIND[kind] === 'items' ? (row.type ?? kind) : kind,
    subtype: subtypeOf(row),
    folder: row.category?.name ?? null,
    tags: row.tags ?? [],
    starred: Boolean(row.isStarred),
    timesUsed: row.usageCount ?? 0,
    lastUsed: humanDate(row.lastUsedAt),
    added: humanDate(row.createdAt),
  };
}

export function createLibraryTools(deps: LibraryDeps): AgentToolDefinition[] {
  /** Route a kind to its service, with the filters that kind implies. */
  async function listOf(
    kind: LibraryKind,
    ctx: ToolContext,
    query: Record<string, unknown>,
  ): Promise<Listed> {
    const source = SOURCE_BY_KIND[kind];
    const itemType = ITEM_TYPE_BY_KIND[kind];

    switch (source) {
      case 'items':
        return deps.items.findAll(ctx.workspaceId, {
          ...query,
          ...(itemType ? { type: itemType } : {}),
        });
      case 'templates':
        return deps.templates.findAll(ctx.workspaceId, query);
      case 'snippets':
        return deps.snippets.findAll(ctx.workspaceId, query);
      case 'links':
        return deps.links.findAll(ctx.workspaceId, query);
      case 'categories': {
        const rows = await deps.categories.findAll(ctx.workspaceId);
        const list = Array.isArray(rows) ? (rows as LibraryRow[]) : [];
        return { items: list, total: list.length };
      }
    }
  }

  return [
    {
      name: 'search_library',
      description:
        "Search the workspace's OWN saved library — the things this user uploaded or created. " +
        'Use this for "my images", "our logo", "the caption I saved", "my templates". ' +
        'NOT for stock photography: when the user needs a picture they do not already have, ' +
        'use search_media instead, which searches Unsplash and Pexels. ' +
        'Covers every kind of library content: media (images, video, gifs, documents), ' +
        'templates, text snippets, saved links, and folders.\n\n' +
        'Read-only. It finds and describes; it does not upload, rename, or delete.\n\n' +
        REFERENCE_USAGE_HINT,
      inputSchema: {
        kind: z
          .enum(LIBRARY_KINDS)
          .optional()
          .describe(
            "What to search. 'media' covers images, video and gifs together — " +
              'prefer it unless the user named one type. Defaults to media.',
          ),
        search: z
          .string()
          .optional()
          .describe('Match against the name and description.'),
        starred: z
          .boolean()
          .optional()
          .describe('Only items the user starred.'),
        recentlyUsed: z
          .boolean()
          .optional()
          .describe(
            'Order by most recently used rather than most recently added. ' +
              'Use for "the image I used last week".',
          ),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
      },
      handler: async (args, ctx) => {
        const kind = (args.kind as LibraryKind) ?? 'media';
        const limit = Math.min(
          typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT,
          MAX_LIMIT,
        );

        const query: Record<string, unknown> = { limit };
        if (typeof args.search === 'string' && args.search.trim()) {
          query.search = args.search.trim();
        }
        if (args.starred === true) query.isStarred = true;
        if (args.recentlyUsed === true) {
          query.sortBy = 'lastUsedAt';
          query.sortOrder = 'desc';
        }

        const { items, total } = await listOf(kind, ctx, query);

        return withReferences(
          {
            kind,
            // Where the Library page opens for this kind. The Library has no
            // per-item route, so a chip reaches the right shelf, not the exact
            // row — said plainly so the model does not promise more.
            section: SECTION_BY_KIND[kind],
            showing: items.length,
            total,
            items: items.map((row) => summarize(row, kind)),
            emptyReason:
              items.length === 0
                ? 'Nothing in the library matches. This searches only what this workspace saved — for stock photography, use search_media.'
                : null,
          },
          items.map((row) => chipFor(row, kind)),
        );
      },
    },

    {
      name: 'get_library_item',
      description:
        'Full detail for one item in the workspace library — its URL, dimensions, ' +
        'file size, folder, tags, and how often it has been used. ' +
        'For a template, also returns the template body: its text, placeholders, ' +
        'hashtags and media slots. Read-only.\n\n' +
        REFERENCE_USAGE_HINT,
      inputSchema: {
        id: z.string().describe('The item id, as returned by search_library.'),
        kind: z
          .enum(['media', 'template', 'snippet', 'link'])
          .describe('Which kind of library item this id belongs to.'),
      },
      handler: async (args, ctx) => {
        const kind = args.kind as 'media' | 'template' | 'snippet' | 'link';
        const id = String(args.id);

        const service =
          kind === 'template'
            ? deps.templates
            : kind === 'snippet'
              ? deps.snippets
              : kind === 'link'
                ? deps.links
                : deps.items;

        const row = await service.findOne(ctx.workspaceId, id);
        if (!row) {
          return {
            found: false,
            message:
              'No such item in this workspace library. It may have been deleted, or the id may belong to a different kind.',
          };
        }

        const base = summarize(row, kind as LibraryKind);
        return withReferences(
          {
            found: true,
            ...base,
            description: row.description ?? null,
            url: row.fileUrl ?? row.url ?? null,
            thumbnailUrl: row.thumbnailUrl ?? null,
            mimeType: row.mimeType ?? null,
            size: humanSize(row.fileSize),
            dimensions:
              row.width && row.height ? `${row.width}x${row.height}` : null,
            durationSeconds: row.duration ?? null,
            platforms: row.platforms ?? null,
            // A template's body IS the answer when someone asks about one, so
            // it is returned whole rather than summarised into uselessness.
            template: kind === 'template' ? (row.content ?? null) : null,
            snippet: kind === 'snippet' ? (row.content ?? null) : null,
            section: SECTION_BY_KIND[kind as LibraryKind],
          },
          [chipFor(row, kind as LibraryKind)],
        );
      },
    },
  ];
}
