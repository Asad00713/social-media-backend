import type { AgentToolDefinition, ToolContext } from '../maestro.types';
import { createLibraryTools, type LibraryDeps } from './library.tools';
import { isReferencePayload } from './references';

const CTX: ToolContext = { userId: 'u1', workspaceId: 'ws-1' };

interface Row {
  id: string;
  name: string;
  type?: string;
  templateType?: string;
  snippetType?: string;
  isStarred?: boolean;
  usageCount?: number;
  content?: unknown;
  category?: { id: string; name: string } | null;
  [k: string]: unknown;
}

/** What each fake service was asked for, so routing can be asserted. */
interface Call {
  service: string;
  workspaceId: string;
  query: Record<string, unknown>;
}

function fakeDeps(
  data: {
    items?: Row[];
    templates?: Row[];
    snippets?: Row[];
    links?: Row[];
    categories?: Row[];
  } = {},
  calls: Call[] = [],
): LibraryDeps {
  const make = (service: string, rows: Row[]) => ({
    findAll: (workspaceId: string, query: Record<string, unknown>) => {
      calls.push({ service, workspaceId, query });
      let out = rows;
      // Only the filters the tool actually sets, so a test can prove they land.
      if (typeof query.type === 'string') {
        out = out.filter((r) => r.type === query.type);
      }
      if (query.isStarred === true) out = out.filter((r) => r.isStarred);
      if (typeof query.search === 'string') {
        const q = query.search.toLowerCase();
        out = out.filter((r) => r.name.toLowerCase().includes(q));
      }
      return Promise.resolve({ items: out, total: out.length });
    },
    create: (
      workspaceId: string,
      userId: string,
      dto: Record<string, unknown>,
    ) => {
      calls.push({ service, workspaceId, query: { ...dto, userId } });
      const row = { id: `new-${service}`, name: String(dto.name), ...dto };
      rows.push(row as Row);
      return Promise.resolve(row);
    },
    findOne: (workspaceId: string, id: string) => {
      calls.push({ service, workspaceId, query: { id } });
      return Promise.resolve(rows.find((r) => r.id === id) ?? null);
    },
  });

  return {
    items: make('items', data.items ?? []),
    templates: make('templates', data.templates ?? []),
    snippets: make('snippets', data.snippets ?? []),
    links: make('links', data.links ?? []),
    categories: {
      findAll: (workspaceId: string) => {
        calls.push({ service: 'categories', workspaceId, query: {} });
        return Promise.resolve(data.categories ?? []);
      },
    },
  } as unknown as LibraryDeps;
}

function tool(tools: AgentToolDefinition[], name: string): AgentToolDefinition {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

/** The tool's own data, unwrapped from the reference envelope. */
function dataOf<T>(result: unknown): T {
  if (!isReferencePayload(result)) {
    throw new Error('expected a reference payload');
  }
  return result.data as T;
}

function refsOf(result: unknown) {
  if (!isReferencePayload(result)) {
    throw new Error('expected a reference payload');
  }
  return result.refs;
}

interface SearchData {
  kind: string;
  section: string;
  showing: number;
  total: number;
  items: { id: string; name: string; kind: string; subtype: string | null }[];
  emptyReason: string | null;
}

describe('library tools', () => {
  describe('search_library', () => {
    it('names each result so the user can click through to it', async () => {
      const tools = createLibraryTools(
        fakeDeps({ items: [{ id: 'm-1', name: 'Logo', type: 'image' }] }),
      );

      const result = await tool(tools, 'search_library').handler({}, CTX);

      // Plain text would be a dead end: the whole point of a chip is that the
      // name is a way INTO the library, not just a word in a sentence.
      expect(refsOf(result)).toEqual([
        { kind: 'media', id: 'm-1', label: 'Logo', status: 'image' },
      ]);
    });

    it('defaults to media, so "show me my images" needs no argument', async () => {
      const calls: Call[] = [];
      const tools = createLibraryTools(fakeDeps({ items: [] }, calls));

      await tool(tools, 'search_library').handler({}, CTX);

      expect(calls[0].service).toBe('items');
      // 'media' spans image/video/gif, so it must NOT narrow to one type.
      expect(calls[0].query.type).toBeUndefined();
    });

    it.each([
      ['template', 'templates'],
      ['snippet', 'snippets'],
      ['link', 'links'],
      ['folder', 'categories'],
    ])('routes kind=%s to the %s service', async (kind, service) => {
      const calls: Call[] = [];
      const tools = createLibraryTools(fakeDeps({}, calls));

      await tool(tools, 'search_library').handler({ kind }, CTX);

      expect(calls[0].service).toBe(service);
    });

    it('narrows to one asset type when the user named one', async () => {
      const calls: Call[] = [];
      const tools = createLibraryTools(
        fakeDeps(
          {
            items: [
              { id: 'm-1', name: 'Clip', type: 'video' },
              { id: 'm-2', name: 'Logo', type: 'image' },
            ],
          },
          calls,
        ),
      );

      const result = await tool(tools, 'search_library').handler(
        { kind: 'video' },
        CTX,
      );

      expect(calls[0].query.type).toBe('video');
      expect(dataOf<SearchData>(result).items.map((i) => i.name)).toEqual([
        'Clip',
      ]);
    });

    // Every kind, not just the default: a leak only has to exist on ONE route
    // to be a leak, and each kind reaches a different service.
    it.each(['media', 'video', 'template', 'snippet', 'link', 'folder'])(
      'reads the caller workspace for kind=%s, ignoring any workspaceId argument',
      async (kind) => {
        const calls: Call[] = [];
        const tools = createLibraryTools(fakeDeps({}, calls));

        await tool(tools, 'search_library').handler(
          { kind, workspaceId: 'ws-someone-else' },
          CTX,
        );

        // Tenant scope comes from the authenticated context, never the model.
        expect(calls[0].workspaceId).toBe('ws-1');
      },
    );

    it('does not forward a model-supplied workspaceId as a filter', async () => {
      const calls: Call[] = [];
      const tools = createLibraryTools(fakeDeps({}, calls));

      await tool(tools, 'search_library').handler(
        { workspaceId: 'ws-someone-else' },
        CTX,
      );

      expect(calls[0].query.workspaceId).toBeUndefined();
    });

    it('ignores an unknown workspaceId argument on the default route', async () => {
      const calls: Call[] = [];
      const tools = createLibraryTools(fakeDeps({}, calls));

      await tool(tools, 'search_library').handler(
        { workspaceId: 'ws-someone-else' },
        CTX,
      );

      // Tenant scope comes from the authenticated context, never the model.
      expect(calls[0].workspaceId).toBe('ws-1');
    });

    it('sends the user somewhere useful when nothing matches', async () => {
      const tools = createLibraryTools(fakeDeps({ items: [] }));

      const data = dataOf<SearchData>(
        await tool(tools, 'search_library').handler({ search: 'nope' }, CTX),
      );

      expect(data.showing).toBe(0);
      // An empty library and an empty STOCK search are different problems with
      // different fixes; saying so is what stops "you have no images" landing
      // as the final word.
      expect(data.emptyReason).toMatch(/search_media/);
    });

    it('orders by last used when asked for the one they used recently', async () => {
      const calls: Call[] = [];
      const tools = createLibraryTools(fakeDeps({ items: [] }, calls));

      await tool(tools, 'search_library').handler({ recentlyUsed: true }, CTX);

      expect(calls[0].query.sortBy).toBe('lastUsedAt');
      expect(calls[0].query.sortOrder).toBe('desc');
    });

    it('passes the starred filter through', async () => {
      const calls: Call[] = [];
      const tools = createLibraryTools(fakeDeps({ items: [] }, calls));

      await tool(tools, 'search_library').handler({ starred: true }, CTX);

      expect(calls[0].query.isStarred).toBe(true);
    });

    it('caps the page size however large a limit is asked for', async () => {
      const calls: Call[] = [];
      const tools = createLibraryTools(fakeDeps({ items: [] }, calls));

      await tool(tools, 'search_library').handler({ limit: 5000 }, CTX);

      expect(calls[0].query.limit as number).toBeLessThanOrEqual(40);
    });

    it('keeps the sub-type that made the user save it separately', async () => {
      const tools = createLibraryTools(
        fakeDeps({
          templates: [{ id: 't-1', name: 'Launch', templateType: 'carousel' }],
        }),
      );

      const data = dataOf<SearchData>(
        await tool(tools, 'search_library').handler({ kind: 'template' }, CTX),
      );

      // "A template" is not the answer when the library holds carousels,
      // stories and single posts side by side.
      expect(data.items[0].subtype).toBe('carousel');
    });

    it('says which shelf of the Library a kind opens', async () => {
      const tools = createLibraryTools(fakeDeps({ snippets: [] }));

      const data = dataOf<SearchData>(
        await tool(tools, 'search_library').handler({ kind: 'snippet' }, CTX),
      );

      // The Library is one screen driven by ?section=, with no per-item route,
      // so the shelf is the most precise honest destination.
      expect(data.section).toBe('type-text_snippet');
    });
  });

  describe('get_library_item', () => {
    it("returns a template's body, which is the answer when asked about one", async () => {
      const body = {
        text: 'Launching {{product}} today',
        hashtags: ['#launch'],
        mediaSlots: [],
      };
      const tools = createLibraryTools(
        fakeDeps({
          templates: [
            { id: 't-1', name: 'Launch', templateType: 'post', content: body },
          ],
        }),
      );

      const data = dataOf<{ template: unknown; found: boolean }>(
        await tool(tools, 'get_library_item').handler(
          { id: 't-1', kind: 'template' },
          CTX,
        ),
      );

      expect(data.found).toBe(true);
      // Summarising the body away would answer "what does this template say?"
      // with everything except what it says.
      expect(data.template).toEqual(body);
    });

    it('explains a miss instead of returning a bare null', async () => {
      const tools = createLibraryTools(fakeDeps({ items: [] }));

      const result = (await tool(tools, 'get_library_item').handler(
        { id: 'gone', kind: 'media' },
        CTX,
      )) as { found: boolean; message: string };

      expect(result.found).toBe(false);
      // The id may simply belong to another kind — a distinction the model can
      // act on, where a null leaves it guessing.
      expect(result.message).toMatch(/different kind/i);
    });

    it('looks the id up in the service its kind belongs to', async () => {
      const calls: Call[] = [];
      const tools = createLibraryTools(
        fakeDeps({ snippets: [{ id: 's-1', name: 'CTA' }] }, calls),
      );

      await tool(tools, 'get_library_item').handler(
        { id: 's-1', kind: 'snippet' },
        CTX,
      );

      expect(calls[0].service).toBe('snippets');
      expect(calls[0].workspaceId).toBe('ws-1');
    });

    it('reports size and dimensions in words a person would use', async () => {
      const tools = createLibraryTools(
        fakeDeps({
          items: [
            {
              id: 'm-1',
              name: 'Hero',
              type: 'image',
              fileSize: 2_097_152,
              width: 1920,
              height: 1080,
            },
          ],
        }),
      );

      const data = dataOf<{ size: string; dimensions: string }>(
        await tool(tools, 'get_library_item').handler(
          { id: 'm-1', kind: 'media' },
          CTX,
        ),
      );

      expect(data.size).toBe('2.0 MB');
      expect(data.dimensions).toBe('1920x1080');
    });
  });

  describe('creating', () => {
    /** Tools with the confirm gate switched off, for the act-and-assert cases. */
    function unguarded(deps: LibraryDeps) {
      return createLibraryTools(deps, { confirmBeforeSend: false });
    }

    it('asks before writing anything to the library', async () => {
      const calls: Call[] = [];
      const tools = createLibraryTools(fakeDeps({}, calls));

      const result = (await tool(tools, 'create_template').handler(
        { name: 'Launch', text: 'Hello {{name}}' },
        CTX,
      )) as { kind: string };

      // A confirm CARD, and -- the part that matters -- nothing written yet.
      expect(result.kind).toBe('question');
      expect(calls).toHaveLength(0);
    });

    it('writes once the user has approved', async () => {
      const calls: Call[] = [];
      const tools = createLibraryTools(fakeDeps({}, calls));

      const result = await tool(tools, 'create_template').handler(
        { name: 'Launch', text: 'Hello {{name}}', confirmed: true },
        CTX,
      );

      expect(calls[0].service).toBe('templates');
      expect(dataOf<{ created: boolean }>(result).created).toBe(true);
    });

    it.each([
      ['create_template', { name: 'X', text: 'body' }],
      [
        'create_snippet',
        { name: 'X', content: 'body', snippetType: 'caption' },
      ],
      ['save_link', { name: 'X', url: 'https://example.com' }],
    ])('%s stamps the asking user, not the agent', async (name, args) => {
      const calls: Call[] = [];
      const tools = unguarded(fakeDeps({}, calls));

      await tool(tools, name).handler(args, CTX);

      // An agent-authored row still belongs to the person who asked for it.
      expect(calls[0].query.userId).toBe('u1');
      expect(calls[0].workspaceId).toBe('ws-1');
    });

    it('returns a chip so the new thing is reachable straight away', async () => {
      const tools = unguarded(fakeDeps({}));

      const result = await tool(tools, 'create_snippet').handler(
        { name: 'CTA', content: 'Link in bio', snippetType: 'cta' },
        CTX,
      );

      expect(refsOf(result)[0].label).toBe('CTA');
    });

    it('keeps the template body intact, placeholders and all', async () => {
      const calls: Call[] = [];
      const tools = unguarded(fakeDeps({}, calls));

      await tool(tools, 'create_template').handler(
        {
          name: 'Launch',
          text: 'Launching {{product}} today',
          hashtags: ['#launch'],
        },
        CTX,
      );

      // Placeholders are the whole point: a template with a real product name
      // baked in is a post, not a template.
      expect(calls[0].query.content).toEqual({
        text: 'Launching {{product}} today',
        hashtags: ['#launch'],
        mediaSlots: [],
      });
    });

    it.each([
      ['create_template', { name: '', text: 'body' }],
      ['create_template', { name: 'X', text: '   ' }],
      ['create_snippet', { name: 'X', content: '', snippetType: 'cta' }],
      ['save_link', { name: 'X', url: '' }],
    ])(
      '%s refuses an incomplete request instead of saving a blank',
      async (name, args) => {
        const calls: Call[] = [];
        const tools = unguarded(fakeDeps({}, calls));

        const result = (await tool(tools, name).handler(args, CTX)) as {
          created: boolean;
          message: string;
        };

        expect(result.created).toBe(false);
        // The message names what is missing, so the model can ask for it rather
        // than retrying the same empty call.
        expect(result.message).toMatch(/needs/i);
        expect(calls).toHaveLength(0);
      },
    );

    it('rejects a URL that is not one, in words the model can act on', async () => {
      const calls: Call[] = [];
      const tools = unguarded(fakeDeps({}, calls));

      const result = (await tool(tools, 'save_link').handler(
        { name: 'Docs', url: 'example.com' },
        CTX,
      )) as { created: boolean; message: string };

      expect(result.created).toBe(false);
      expect(result.message).toMatch(/https?:\/\//);
      expect(calls).toHaveLength(0);
    });

    it('defaults a template to a post, the commonest case', async () => {
      const calls: Call[] = [];
      const tools = unguarded(fakeDeps({}, calls));

      await tool(tools, 'create_template').handler(
        { name: 'X', text: 'body' },
        CTX,
      );

      expect(calls[0].query.templateType).toBe('post');
    });
  });

  describe('tool surface', () => {
    it('creates but never deletes', () => {
      const names = createLibraryTools(fakeDeps({})).map((t) => t.name);

      // Creating is allowed; DELETING is deliberately still absent -- an agent
      // that cannot delete cannot delete the wrong thing.
      expect(names).toEqual([
        'search_library',
        'get_library_item',
        'create_template',
        'create_snippet',
        'save_link',
      ]);
    });

    it('tells the model apart from stock search in its own description', () => {
      const [search] = createLibraryTools(fakeDeps({}));

      // The description is what the model reads while CHOOSING, so the
      // distinction has to live here, not only in the system prompt.
      expect(search.description).toMatch(/search_media/);
      expect(search.description).toMatch(/read-only/i);
    });
  });
});
