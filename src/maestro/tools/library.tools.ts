import { z } from 'zod';
import type { AgentToolDefinition, ToolContext } from '../maestro.types';
import { confirmCard, isConfirmed } from './confirm';
import {
  TEMPLATE_TYPES,
  TEXT_SNIPPET_TYPES,
  type TemplateType,
  type TextSnippetType,
} from '../../drizzle/schema/media-library.schema';
import type {
  CreateTemplateDto,
  CreateTextSnippetDto,
  CreateSavedLinkDto,
} from '../../media-library/dto/media-library.dto';
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

/** A library service Maestro can only read from. */
interface ReadableStore {
  findAll(workspaceId: string, query: Record<string, unknown>): Promise<Listed>;
  findOne(workspaceId: string, id: string): Promise<LibraryRow | null>;
}

/**
 * A store Maestro can also write to.
 *
 * `userId` is separate from the workspace because the services record WHO
 * created a row. An agent-authored template is still the work of the person who
 * asked for it, so their id is what gets stamped — not a synthetic agent
 * identity that would leave the library full of rows belonging to nobody.
 */
interface WritableStore<TDto = never> extends ReadableStore {
  // The DTO type is the service's own, so a field this file spells wrong is a
  // compile error rather than a validation failure discovered at runtime.
  create(workspaceId: string, userId: string, dto: TDto): Promise<LibraryRow>;
}

export interface LibraryDeps {
  /** Uploads need a file; Maestro has no bytes to upload, so this stays read-only. */
  items: ReadableStore;
  templates: WritableStore<CreateTemplateDto>;
  snippets: WritableStore<CreateTextSnippetDto>;
  links: WritableStore<CreateSavedLinkDto>;
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

/**
 * A tool argument as a trimmed string, or '' if it is not one.
 *
 * Deliberately NOT String(value): the model can pass an object or an array
 * where a string was asked for, and String() would turn that into the literal
 * text "[object Object]" — which then passes the non-empty check and gets saved
 * as somebody's template name.
 */
function textArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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

export function createLibraryTools(
  deps: LibraryDeps,
  opts: { confirmBeforeSend: boolean } = { confirmBeforeSend: true },
): AgentToolDefinition[] {
  const { confirmBeforeSend } = opts;

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

    {
      name: 'create_template',
      description:
        'Save a reusable post template to the workspace library. Use when the user ' +
        'asks to turn a post, caption or idea into something they can reuse — ' +
        '"save this as a template", "make me a launch template".\n\n' +
        'The body supports {{placeholders}} for the parts that change each time ' +
        '(e.g. "Launching {{product}} today"). Prefer them over inventing specifics: ' +
        'a template with a real product name baked in is a post, not a template.\n\n' +
        "This writes to the user's library. WRITES — it needs confirmation.\n\n" +
        REFERENCE_USAGE_HINT,
      inputSchema: {
        name: z
          .string()
          .max(255)
          .describe('Short name the user will recognise in their library.'),
        text: z
          .string()
          .describe(
            'The template body. Use {{placeholder}} for the parts that change.',
          ),
        templateType: z
          .enum(TEMPLATE_TYPES)
          .optional()
          .describe('Defaults to post.'),
        hashtags: z
          .array(z.string())
          .optional()
          .describe('Hashtags to attach, each including its #.'),
        platforms: z
          .array(z.string())
          .optional()
          .describe('Platforms this template is meant for, if the user said.'),
        description: z.string().optional(),
        confirmed: z.boolean().optional(),
      },
      handler: async (args, ctx) => {
        const name = textArg(args.name);
        const text = textArg(args.text);
        if (!name || !text) {
          return {
            created: false,
            message:
              'A template needs both a name and body text. Ask the user for whichever is missing.',
          };
        }

        const templateType =
          (args.templateType as TemplateType | undefined) ?? 'post';
        if (!isConfirmed(confirmBeforeSend, args)) {
          return confirmCard(
            `Save "${name}" as a ${templateType} template in your library?`,
            'Yes, save it',
          );
        }

        const created = await deps.templates.create(
          ctx.workspaceId,
          ctx.userId,
          {
            name,
            templateType,
            description:
              typeof args.description === 'string'
                ? args.description
                : undefined,
            platforms: Array.isArray(args.platforms)
              ? args.platforms
              : undefined,
            content: {
              text,
              hashtags: Array.isArray(args.hashtags) ? args.hashtags : [],
              mediaSlots: [],
            },
          },
        );

        return withReferences(
          {
            created: true,
            id: created.id,
            name: created.name,
            section: SECTION_BY_KIND.template,
          },
          [chipFor(created, 'template')],
        );
      },
    },

    {
      name: 'create_snippet',
      description:
        'Save a reusable piece of text to the workspace library — a caption, a ' +
        'hashtag set, a call to action, a bio. Use for "save these hashtags", ' +
        '"keep this caption for later".\n\n' +
        'WRITES — it needs confirmation.\n\n' +
        REFERENCE_USAGE_HINT,
      inputSchema: {
        name: z.string().max(255).describe('Short recognisable name.'),
        content: z.string().describe('The text itself.'),
        snippetType: z
          .enum(TEXT_SNIPPET_TYPES)
          .describe(
            'What kind of text this is. Pick the one that matches — it is how the user finds it later.',
          ),
        confirmed: z.boolean().optional(),
      },
      handler: async (args, ctx) => {
        const name = textArg(args.name);
        const content = textArg(args.content);
        if (!name || !content) {
          return {
            created: false,
            message:
              'A snippet needs both a name and its text. Ask the user for whichever is missing.',
          };
        }

        const snippetType =
          (args.snippetType as TextSnippetType | undefined) ?? 'other';
        if (!isConfirmed(confirmBeforeSend, args)) {
          return confirmCard(
            `Save "${name}" as a ${snippetType} snippet in your library?`,
            'Yes, save it',
          );
        }

        const created = await deps.snippets.create(
          ctx.workspaceId,
          ctx.userId,
          { name, content, snippetType },
        );

        return withReferences(
          {
            created: true,
            id: created.id,
            name: created.name,
            section: SECTION_BY_KIND.snippet,
          },
          [chipFor(created, 'snippet')],
        );
      },
    },

    {
      name: 'save_link',
      description:
        'Save a URL to the workspace library for later reference. Use for ' +
        '"save this link", "bookmark this article".\n\n' +
        'WRITES — it needs confirmation.\n\n' +
        REFERENCE_USAGE_HINT,
      inputSchema: {
        name: z.string().max(255).describe('Short recognisable name.'),
        url: z.string().describe('The full URL, including https://'),
        description: z.string().optional(),
        confirmed: z.boolean().optional(),
      },
      handler: async (args, ctx) => {
        const name = textArg(args.name);
        const url = textArg(args.url);
        if (!name || !url) {
          return {
            created: false,
            message:
              'Saving a link needs both a name and a URL. Ask the user for whichever is missing.',
          };
        }
        // Checked here as well as by the DTO so the model gets a sentence it can
        // act on, rather than a validation error it has to decode.
        if (!/^https?:\/\//i.test(url)) {
          return {
            created: false,
            message: `"${url}" is not a full URL. It needs to start with http:// or https://.`,
          };
        }

        if (!isConfirmed(confirmBeforeSend, args)) {
          return confirmCard(`Save "${name}" to your library?`, 'Yes, save it');
        }

        const created = await deps.links.create(ctx.workspaceId, ctx.userId, {
          name,
          url,
          description:
            typeof args.description === 'string' ? args.description : undefined,
        });

        return withReferences(
          {
            created: true,
            id: created.id,
            name: created.name,
            section: SECTION_BY_KIND.link,
          },
          [chipFor(created, 'link')],
        );
      },
    },
  ];
}
