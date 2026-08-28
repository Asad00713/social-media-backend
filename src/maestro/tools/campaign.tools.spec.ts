import type {
  CampaignsService,
  CampaignDto,
} from '../../campaigns/campaigns.service';
import type { AgentToolDefinition, ToolContext } from '../maestro.types';
import { createCampaignTools } from './campaign.tools';
import { isReferencePayload, type ReferencePayload } from './references';

const CTX: ToolContext = { userId: 'u1', workspaceId: 'ws-1' };

/** A campaign as `list`/`getOne` return it — only the fields the tools read. */
function campaignRow(over: Partial<CampaignDto> = {}): CampaignDto {
  return {
    id: 'c-1',
    workspaceId: 'ws-1',
    name: 'Launch week',
    description: null,
    type: 'bulk',
    status: 'active',
    channelIds: ['1', '2'],
    platforms: ['instagram', 'facebook'],
    schedule: {
      type: 'bulk',
      startDate: '2026-09-01',
      endDate: '2026-09-07',
      defaultTime: '09:00',
      timezone: 'UTC',
      blackoutDates: [],
      skipWeekends: false,
    },
    contentSource: 'manual',
    aiConfig: null,
    libraryTemplateIds: [],
    slotContent: {},
    metrics: {
      postsPlanned: 10,
      postsPublished: 4,
      postsFailed: 1,
      postsSkipped: 0,
    },
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    launchedAt: '2026-09-01T00:00:00.000Z',
    nextRunAt: '2026-09-03T09:00:00.000Z',
    ...over,
  };
}

interface Recorded {
  workspaceId: string;
  filters?: unknown;
  id?: string;
}

function fakeService(rows: CampaignDto[], calls: Recorded[] = []) {
  return {
    list: (workspaceId: string, filters?: Record<string, string>) => {
      calls.push({ workspaceId, filters });
      let out = rows.filter((r) => r.workspaceId === workspaceId);
      if (filters?.status) out = out.filter((r) => r.status === filters.status);
      if (filters?.search) {
        const q = filters.search.toLowerCase();
        out = out.filter((r) => r.name.toLowerCase().includes(q));
      }
      return Promise.resolve(out);
    },
    getOne: (workspaceId: string, id: string) => {
      calls.push({ workspaceId, id });
      const found = rows.find(
        (r) => r.id === id && r.workspaceId === workspaceId,
      );
      if (!found) return Promise.reject(new Error('Campaign not found'));
      return Promise.resolve(found);
    },
  } as unknown as CampaignsService;
}

function tool(tools: AgentToolDefinition[], name: string): AgentToolDefinition {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

describe('campaign tools', () => {
  describe('list_campaigns', () => {
    it('returns each campaign with a reference so its name can be linked', async () => {
      const tools = createCampaignTools(fakeService([campaignRow()]));
      const result = (await tool(tools, 'list_campaigns').handler(
        {},
        CTX,
      )) as ReferencePayload;

      expect(isReferencePayload(result)).toBe(true);
      expect(result.refs).toEqual([
        { kind: 'campaign', id: 'c-1', label: 'Launch week', status: 'active' },
      ]);
    });

    it("gives the reference the campaign's real status, so the chip is the right colour", async () => {
      const tools = createCampaignTools(
        fakeService([campaignRow({ status: 'paused' })]),
      );
      const result = (await tool(tools, 'list_campaigns').handler(
        {},
        CTX,
      )) as ReferencePayload;

      expect(result.refs[0].status).toBe('paused');
    });

    it("reads only the caller's workspace, never one passed as an argument", async () => {
      const calls: Recorded[] = [];
      const tools = createCampaignTools(
        fakeService(
          [
            campaignRow({ id: 'mine', workspaceId: 'ws-1' }),
            campaignRow({ id: 'theirs', workspaceId: 'ws-2', name: 'Theirs' }),
          ],
          calls,
        ),
      );

      const result = (await tool(tools, 'list_campaigns').handler(
        { workspaceId: 'ws-2' },
        CTX,
      )) as ReferencePayload;

      expect(calls[0].workspaceId).toBe('ws-1');
      expect(result.refs.map((r) => r.id)).toEqual(['mine']);
    });

    it('reports the true total even when the page is trimmed', async () => {
      const rows = Array.from({ length: 12 }, (_, i) =>
        campaignRow({ id: `c-${i}`, name: `Campaign ${i}` }),
      );
      const tools = createCampaignTools(fakeService(rows));

      const result = (await tool(tools, 'list_campaigns').handler(
        { limit: 3 },
        CTX,
      )) as ReferencePayload;
      const data = result.data as { total: number; showing: number };

      // Saying "you have 3 campaigns" when there are 12 would be wrong.
      expect(data.total).toBe(12);
      expect(data.showing).toBe(3);
      expect(result.refs).toHaveLength(3);
    });

    it('passes a status filter through to the service', async () => {
      const calls: Recorded[] = [];
      const tools = createCampaignTools(
        fakeService(
          [
            campaignRow({ id: 'a', status: 'active' }),
            campaignRow({ id: 'p', status: 'paused' }),
          ],
          calls,
        ),
      );

      const result = (await tool(tools, 'list_campaigns').handler(
        { status: 'paused' },
        CTX,
      )) as ReferencePayload;

      expect(calls[0].filters).toEqual({ status: 'paused' });
      expect(result.refs.map((r) => r.id)).toEqual(['p']);
    });

    it('returns an empty reference list rather than nothing when there are no campaigns', async () => {
      const tools = createCampaignTools(fakeService([]));
      const result = (await tool(tools, 'list_campaigns').handler(
        {},
        CTX,
      )) as ReferencePayload;

      expect(isReferencePayload(result)).toBe(true);
      expect(result.refs).toEqual([]);
      expect((result.data as { total: number }).total).toBe(0);
    });

    it('describes an evergreen campaign as ongoing, never with an end date', async () => {
      const tools = createCampaignTools(
        fakeService([
          campaignRow({
            type: 'evergreen',
            schedule: {
              type: 'evergreen',
              startDate: '2026-09-01',
              weekdays: [1, 3, 5],
              times: ['09:00'],
              timezone: 'UTC',
              blackoutDates: [],
              loop: true,
            },
          }),
        ]),
      );
      const result = (await tool(tools, 'list_campaigns').handler(
        {},
        CTX,
      )) as ReferencePayload;
      const { campaigns } = result.data as {
        campaigns: { schedule: string | null }[];
      };

      expect(campaigns[0].schedule).toBe('from 2026-09-01, ongoing');
    });

    it('does not invent an end date for a drip campaign that has none', async () => {
      const tools = createCampaignTools(
        fakeService([
          campaignRow({
            type: 'drip',
            schedule: {
              type: 'drip',
              startDate: '2026-09-01',
              endDate: null,
              weekdays: [1, 3],
              times: ['09:00', '17:00'],
              timezone: 'UTC',
              blackoutDates: [],
            },
          }),
        ]),
      );
      const result = (await tool(tools, 'list_campaigns').handler(
        {},
        CTX,
      )) as ReferencePayload;
      const { campaigns } = result.data as {
        campaigns: { schedule: string | null }[];
      };

      expect(campaigns[0].schedule).toBe('from 2026-09-01, no end date');
    });

    it('carries the progress counts the user asks about', async () => {
      const tools = createCampaignTools(fakeService([campaignRow()]));
      const result = (await tool(tools, 'list_campaigns').handler(
        {},
        CTX,
      )) as ReferencePayload;
      const { campaigns } = result.data as {
        campaigns: { progress: Record<string, number> }[];
      };

      expect(campaigns[0].progress).toEqual({
        planned: 10,
        published: 4,
        failed: 1,
        skipped: 0,
      });
    });
  });

  describe('get_campaign', () => {
    it('returns the campaign with a reference so it can be linked', async () => {
      const tools = createCampaignTools(fakeService([campaignRow()]));
      const result = (await tool(tools, 'get_campaign').handler(
        { campaignId: 'c-1' },
        CTX,
      )) as ReferencePayload;

      expect(isReferencePayload(result)).toBe(true);
      expect(result.refs[0].id).toBe('c-1');
      expect(result.refs[0].label).toBe('Launch week');
    });

    it('cannot read a campaign belonging to another workspace', async () => {
      const tools = createCampaignTools(
        fakeService([campaignRow({ id: 'theirs', workspaceId: 'ws-2' })]),
      );

      const result = (await tool(tools, 'get_campaign').handler(
        { campaignId: 'theirs' },
        CTX,
      )) as { error?: string };

      // Indistinguishable from a campaign that never existed — deliberately,
      // so the answer cannot confirm another tenant's ids.
      expect(result.error).toBe('No campaign with that id in this workspace.');
    });

    it('ignores a workspace id the model supplies as an argument', async () => {
      // The tenant boundary has to hold even when the model invents an
      // argument for it. Without this the previous test passes against a
      // handler that reads `args.workspaceId` — verified by injecting exactly
      // that defect, which this test catches and that one does not.
      const calls: Recorded[] = [];
      const tools = createCampaignTools(
        fakeService(
          [campaignRow({ id: 'theirs', workspaceId: 'ws-2' })],
          calls,
        ),
      );

      const result = (await tool(tools, 'get_campaign').handler(
        { campaignId: 'theirs', workspaceId: 'ws-2' },
        CTX,
      )) as { error?: string };

      expect(calls[0].workspaceId).toBe('ws-1');
      expect(result.error).toBe('No campaign with that id in this workspace.');
    });

    it('reports a missing campaign instead of throwing', async () => {
      const tools = createCampaignTools(fakeService([]));
      const result = (await tool(tools, 'get_campaign').handler(
        { campaignId: 'nope' },
        CTX,
      )) as { error?: string };

      expect(result.error).toBeTruthy();
    });

    it('rejects an empty id without calling the service', async () => {
      const calls: Recorded[] = [];
      const tools = createCampaignTools(fakeService([campaignRow()], calls));

      const result = (await tool(tools, 'get_campaign').handler(
        { campaignId: '  ' },
        CTX,
      )) as { error?: string };

      expect(result.error).toBe('A campaign id is required.');
      expect(calls).toHaveLength(0);
    });
  });

  it('registers exactly the two read tools', () => {
    const names = createCampaignTools(fakeService([])).map((t) => t.name);
    expect(names).toEqual(['list_campaigns', 'get_campaign']);
  });
});
