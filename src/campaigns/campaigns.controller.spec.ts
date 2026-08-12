// CampaignsService reads/writes through the module-level `db` singleton (not
// DI), so this spec jest.mocks '../drizzle/db' with a small in-memory fake
// that understands the exact drizzle query-builder chains the service calls
// (select/from/where/orderBy, insert/values/returning, update/set/where,
// delete/where). It's a happy-path fake, not a real query engine — `where`
// conditions are evaluated by inspecting the drizzle-orm SQL condition
// objects for the column/value pairs the service actually uses.

import { randomUUID } from 'crypto';
import {
  campaigns as campaignsTable,
  campaignDays as campaignDaysTable,
  campaignSlotContent as campaignSlotContentTable,
} from '../drizzle/schema/campaigns.schema';

interface Row {
  [key: string]: unknown;
}

/** Drizzle columns carry their DB name (snake_case) but not their JS
 *  property key, so `where` conditions built from `eq(table.workspaceId, …)`
 *  surface `workspace_id`. Build a DB-name -> JS-key map per table (from the
 *  real schema objects) so the fake can translate before matching in-memory
 *  rows, which are keyed by JS property name (as `insert().returning()`
 *  produces them). */
function buildColumnNameMap(table: object): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [jsKey, col] of Object.entries(table)) {
    const dbName = (col as { name?: string })?.name;
    if (typeof dbName === 'string') map[dbName] = jsKey;
  }
  return map;
}

const COLUMN_NAME_MAPS = {
  campaigns: buildColumnNameMap(campaignsTable),
  campaignDays: buildColumnNameMap(campaignDaysTable),
  campaignSlotContent: buildColumnNameMap(campaignSlotContentTable),
};

const tables = {
  campaigns: [] as Row[],
  campaignDays: [] as Row[],
  campaignSlotContent: [] as Row[],
};

function resetTables(): void {
  tables.campaigns = [];
  tables.campaignDays = [];
  tables.campaignSlotContent = [];
}

/** Extracts the column-name -> value equality pairs out of a drizzle `and(eq(...), eq(...))`
 *  or bare `eq(...)` condition tree, matched against column identity via `.name`. */
function extractEqPairs(condition: unknown): Record<string, unknown> {
  const pairs: Record<string, unknown> = {};
  if (!condition || typeof condition !== 'object') return pairs;

  const node = condition as {
    queryChunks?: unknown[];
  };

  // drizzle-orm SQL objects expose their pieces via `queryChunks`. We walk
  // recursively and pick out (Column, value) adjacency — good enough for the
  // simple eq()/and(eq(), eq()) trees this service builds.
  const chunks = node.queryChunks;
  if (Array.isArray(chunks)) {
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i] as { name?: string; queryChunks?: unknown[] };
      // A column chunk is a drizzle Column instance: has `.name` + `.columnType`
      // (StringChunk/SQL nodes don't). Distinguishes it from unrelated `.name`
      // props elsewhere in the tree.
      const isColumn =
        chunk &&
        typeof chunk === 'object' &&
        'name' in chunk &&
        typeof chunk.name === 'string' &&
        'columnType' in (chunk as Record<string, unknown>);
      if (isColumn) {
        // Look for a following Param chunk — identified by a scalar `.value`
        // (StringChunk's `.value` is an array, so it won't match here).
        for (let j = i + 1; j < chunks.length; j += 1) {
          const candidate = chunks[j] as { value?: unknown };
          if (
            candidate &&
            typeof candidate === 'object' &&
            'value' in candidate &&
            !Array.isArray(candidate.value)
          ) {
            pairs[chunk.name as string] = candidate.value;
            break;
          }
        }
      }
      if (chunk && typeof chunk === 'object' && Array.isArray(chunk.queryChunks)) {
        Object.assign(pairs, extractEqPairs(chunk));
      }
    }
  }

  return pairs;
}

function matchesRow(
  row: Row,
  pairs: Record<string, unknown>,
  columnNameMap: Record<string, string>,
): boolean {
  return Object.entries(pairs).every(([dbName, value]) => {
    const jsKey = columnNameMap[dbName] ?? dbName;
    return row[jsKey] === value;
  });
}

function tableFor(
  tableRef: unknown,
): { name: keyof typeof tables; rows: Row[]; columnNameMap: Record<string, string> } | null {
  const ref = tableRef as { [Symbol.for('drizzle:Name')]?: string };
  const name = ref?.[Symbol.for('drizzle:Name') as unknown as string] as
    | string
    | undefined;
  if (name === 'campaigns')
    return { name: 'campaigns', rows: tables.campaigns, columnNameMap: COLUMN_NAME_MAPS.campaigns };
  if (name === 'campaign_days')
    return {
      name: 'campaignDays',
      rows: tables.campaignDays,
      columnNameMap: COLUMN_NAME_MAPS.campaignDays,
    };
  if (name === 'campaign_slot_content')
    return {
      name: 'campaignSlotContent',
      rows: tables.campaignSlotContent,
      columnNameMap: COLUMN_NAME_MAPS.campaignSlotContent,
    };
  return null;
}

function makeSelectBuilder(_fields?: unknown) {
  return {
    from(tableRef: unknown) {
      const table = tableFor(tableRef);
      const rows = table ? table.rows : [];

      const exec = (whereCond?: unknown) => {
        if (!whereCond) return Promise.resolve([...rows]);
        const pairs = extractEqPairs(whereCond);
        return Promise.resolve(
          rows.filter((r) => matchesRow(r, pairs, table?.columnNameMap ?? {})),
        );
      };

      const builder = {
        where(whereCond: unknown) {
          return {
            orderBy: () => exec(whereCond),
            then: (resolve: (v: Row[]) => void, reject: (e: unknown) => void) =>
              exec(whereCond).then(resolve, reject),
          };
        },
        orderBy() {
          return exec();
        },
        then: (resolve: (v: Row[]) => void, reject: (e: unknown) => void) =>
          exec().then(resolve, reject),
      };
      return builder;
    },
  };
}

function makeInsertBuilder(tableRef: unknown) {
  const table = tableFor(tableRef);
  return {
    values(input: Row | Row[]) {
      const items = Array.isArray(input) ? input : [input];
      const inserted = items.map((item) => {
        const row: Row = {
          id: randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
          skip: false,
          description: null,
          libraryTemplateIds: [],
          channelIds: [],
          platforms: [],
          aiConfig: null,
          ...item,
        };
        table?.rows.push(row);
        return row;
      });

      return {
        returning: () => Promise.resolve(inserted),
        then: (resolve: (v: undefined) => void) => Promise.resolve().then(() => resolve(undefined)),
      };
    },
  };
}

function makeUpdateBuilder(tableRef: unknown) {
  const table = tableFor(tableRef);
  return {
    set(patch: Row) {
      return {
        where(whereCond: unknown) {
          const pairs = extractEqPairs(whereCond);
          const rows = table ? table.rows : [];
          for (const row of rows) {
            if (matchesRow(row, pairs, table?.columnNameMap ?? {})) {
              Object.assign(row, patch);
            }
          }
          return Promise.resolve(undefined);
        },
      };
    },
  };
}

function makeDeleteBuilder(tableRef: unknown) {
  const table = tableFor(tableRef);
  return {
    where(whereCond: unknown) {
      const pairs = extractEqPairs(whereCond);
      if (table) {
        const remaining = table.rows.filter(
          (r) => !matchesRow(r, pairs, table.columnNameMap),
        );
        // Mutate the underlying `tables[...]` array in place — `table.rows` is
        // a snapshot reference, so reassigning it would orphan the original.
        table.rows.length = 0;
        table.rows.push(...remaining);
      }
      return Promise.resolve(undefined);
    },
  };
}

jest.mock('../drizzle/db', () => ({
  db: {
    select: (fields?: unknown) => makeSelectBuilder(fields),
    insert: (tableRef: unknown) => makeInsertBuilder(tableRef),
    update: (tableRef: unknown) => makeUpdateBuilder(tableRef),
    delete: (tableRef: unknown) => makeDeleteBuilder(tableRef),
  },
}));

// eslint-disable-next-line import/first
import { CampaignsController } from './campaigns.controller';
// eslint-disable-next-line import/first
import { CampaignsService } from './campaigns.service';
// eslint-disable-next-line import/first
import type { CampaignPublishingService } from './campaign-publishing.service';

const WORKSPACE_ID = randomUUID();
const USER = { userId: randomUUID(), email: 'owner@example.com' };

/**
 * `CampaignsService.launch` (Task 4) now depends on `CampaignPublishingService`,
 * whose real implementation needs a live BullMQ `Queue` (`@InjectQueue`) — too
 * heavy for this thin controller-delegation spec, and unnecessary: every
 * `launch` exercised here uses a non-numeric `channelId` (e.g. `'channel-1'`),
 * which `resolveSlotChannels` can never resolve to a platform, so the slot is
 * always marked "Channel unavailable"/skipped and `materializeAndEnqueue` is
 * never actually invoked. A minimal fake is enough to satisfy the constructor.
 */
function makeFakePublishing(): CampaignPublishingService {
  return {
    materializeAndEnqueue: jest.fn().mockResolvedValue({ postId: 'unused', jobId: 'unused' }),
    cancelSlotJob: jest.fn(),
    buildJobId: jest.fn(),
  } as unknown as CampaignPublishingService;
}

describe('CampaignsController (DB-mocked happy path)', () => {
  let controller: CampaignsController;

  beforeEach(() => {
    resetTables();
    controller = new CampaignsController(new CampaignsService(makeFakePublishing()));
  });

  it('create -> get -> addDay -> addEvent -> updateEvent -> launch assembles the expected Campaign shape', async () => {
    // ---- create ----------------------------------------------------------
    const created = await controller.createSimple(WORKSPACE_ID, USER, {
      name: 'Launch Week',
      description: 'Promo push',
      startDate: '2026-09-01',
      endDate: '2026-09-07',
      timezone: 'UTC',
      defaultTime: '09:00',
      skipWeekends: false,
    });

    expect(created).toMatchObject({
      workspaceId: WORKSPACE_ID,
      name: 'Launch Week',
      type: 'bulk',
      status: 'draft',
      channelIds: [],
      platforms: [],
      slotContent: {},
    });
    expect(created.id).toEqual(expect.any(String));

    // ---- get ---------------------------------------------------------------
    const fetched = await controller.getOne(WORKSPACE_ID, created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.status).toBe('draft');

    // ---- addDay --------------------------------------------------------------
    const afterAddDay = await controller.addDay(WORKSPACE_ID, created.id, {
      date: '2026-09-01',
    });
    expect(afterAddDay.slotContent['2026-09-01']).toEqual({
      channelContent: {},
      skip: false,
    });

    // ---- addEvent ------------------------------------------------------------
    const afterAddEvent = await controller.addEvent(WORKSPACE_ID, created.id, {
      date: '2026-09-01',
      channelId: 'channel-1',
      postType: 'text',
    });
    // channelIds cache is the union of channelId across slot rows regardless
    // of whether it resolves to a real socialMediaChannels row; platforms
    // stays empty here since 'channel-1' isn't a numeric channel id.
    expect(afterAddEvent.channelIds).toEqual(['channel-1']);
    expect(afterAddEvent.platforms).toEqual([]);
    expect(
      afterAddEvent.slotContent['2026-09-01'].channelContent['channel-1'],
    ).toMatchObject({ mode: 'manual', postType: 'text', caption: '' });

    // ---- updateEvent ---------------------------------------------------------
    const afterUpdateEvent = await controller.updateEvent(WORKSPACE_ID, created.id, {
      date: '2026-09-01',
      channelId: 'channel-1',
      patch: { caption: 'Hello world!' },
    });
    expect(
      afterUpdateEvent.slotContent['2026-09-01'].channelContent['channel-1'].caption,
    ).toBe('Hello world!');
    // Merge preserved the rest of the slot content (patch is shallow-merged).
    expect(
      afterUpdateEvent.slotContent['2026-09-01'].channelContent['channel-1'].postType,
    ).toBe('text');

    // Filled slot on a non-skipped day -> counted in metrics.
    expect(afterUpdateEvent.metrics.postsPlanned).toBe(1);

    // ---- launch --------------------------------------------------------------
    const launched = await controller.launch(WORKSPACE_ID, created.id);
    expect(launched.status).toBe('active');
    expect(launched.id).toBe(created.id);
  });

  it('statusCounts reflects created campaigns, and list supports status filtering', async () => {
    await controller.createSimple(WORKSPACE_ID, USER, {
      name: 'A',
      startDate: '2026-09-01',
      endDate: '2026-09-02',
      timezone: 'UTC',
      defaultTime: '09:00',
      skipWeekends: false,
    });
    const second = await controller.createSimple(WORKSPACE_ID, USER, {
      name: 'B',
      startDate: '2026-09-01',
      endDate: '2026-09-02',
      timezone: 'UTC',
      defaultTime: '09:00',
      skipWeekends: false,
    });
    // launch's Task 4 preflight rejects a campaign with no publishable
    // content, so give `second` a filled event before launching — this
    // test is about statusCounts/list filtering, not the preflight itself
    // (that's covered directly in campaigns.service.spec.ts).
    await controller.addDay(WORKSPACE_ID, second.id, { date: '2026-09-01' });
    await controller.addEvent(WORKSPACE_ID, second.id, {
      date: '2026-09-01',
      channelId: 'channel-1',
      postType: 'text',
    });
    await controller.updateEvent(WORKSPACE_ID, second.id, {
      date: '2026-09-01',
      channelId: 'channel-1',
      patch: { caption: 'Hello world!' },
    });
    await controller.launch(WORKSPACE_ID, second.id);

    const counts = await controller.statusCounts(WORKSPACE_ID);
    expect(counts.all).toBe(2);
    expect(counts.draft).toBe(1);
    expect(counts.active).toBe(1);

    const all = await controller.list(WORKSPACE_ID, {});
    expect(all).toHaveLength(2);

    const activeOnly = await controller.list(WORKSPACE_ID, { status: 'active' });
    expect(activeOnly).toHaveLength(1);
    expect(activeOnly[0].id).toBe(second.id);
  });

  it('getOne 404s for a campaign that does not belong to the workspace', async () => {
    const created = await controller.createSimple(WORKSPACE_ID, USER, {
      name: 'Scoped',
      startDate: '2026-09-01',
      endDate: '2026-09-02',
      timezone: 'UTC',
      defaultTime: '09:00',
      skipWeekends: false,
    });

    await expect(
      controller.getOne(randomUUID(), created.id),
    ).rejects.toThrow('Campaign not found');
  });
});
