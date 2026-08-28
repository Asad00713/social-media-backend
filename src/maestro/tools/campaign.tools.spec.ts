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
        {
          kind: 'campaign',
          id: 'c-1',
          label: 'Launch week',
          status: 'active',
          variant: 'bulk',
        },
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
      const { onTrack } = result.data as {
        onTrack: { schedule: string | null }[];
      };

      expect(onTrack[0].schedule).toBe('from 2026-09-01, ongoing');
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
      const { onTrack } = result.data as {
        onTrack: { schedule: string | null }[];
      };

      expect(onTrack[0].schedule).toBe('from 2026-09-01, no end date');
    });

    it('calls a bulk campaign "Simple", the name the product uses', async () => {
      // The UI has never shown the word "bulk" — that is the database's word.
      // An agent that says it is naming a thing the user cannot find.
      const tools = createCampaignTools(fakeService([campaignRow()]));
      const result = (await tool(tools, 'list_campaigns').handler(
        {},
        CTX,
      )) as ReferencePayload;
      const { onTrack } = result.data as { onTrack: { type: string }[] };

      expect(onTrack[0].type).toBe('Simple');
    });

    it('passes an unknown type through rather than dropping it', async () => {
      const tools = createCampaignTools(
        fakeService([campaignRow({ type: 'experimental' })]),
      );
      const result = (await tool(tools, 'list_campaigns').handler(
        {},
        CTX,
      )) as ReferencePayload;
      const { onTrack } = result.data as { onTrack: { type: string }[] };

      expect(onTrack[0].type).toBe('experimental');
    });

    it('splits campaigns into the ones waiting on the user and the rest', async () => {
      const tools = createCampaignTools(
        fakeService([
          campaignRow({ id: 'a', status: 'active' }),
          campaignRow({ id: 'd', status: 'draft' }),
          campaignRow({ id: 'p', status: 'paused' }),
          campaignRow({ id: 'f', status: 'failed' }),
          campaignRow({ id: 'c', status: 'completed' }),
        ]),
      );
      const result = (await tool(tools, 'list_campaigns').handler(
        {},
        CTX,
      )) as ReferencePayload;
      const data = result.data as {
        needsAttentionCount: number;
        onTrackCount: number;
        needsAttention: { id: string }[];
        onTrack: { id: string }[];
      };

      expect(data.needsAttention.map((c) => c.id)).toEqual(['d', 'p', 'f']);
      expect(data.onTrack.map((c) => c.id)).toEqual(['a', 'c']);
      expect(data.needsAttentionCount).toBe(3);
      expect(data.onTrackCount).toBe(2);
    });

    it('still references every campaign, whichever group it landed in', async () => {
      const tools = createCampaignTools(
        fakeService([
          campaignRow({ id: 'a', status: 'active' }),
          campaignRow({ id: 'd', status: 'draft' }),
        ]),
      );
      const result = (await tool(tools, 'list_campaigns').handler(
        {},
        CTX,
      )) as ReferencePayload;

      expect(result.refs.map((r) => r.id).sort()).toEqual(['a', 'd']);
    });

    it('gives each campaign the next step to take, so the prose is not left to invent one', async () => {
      const tools = createCampaignTools(
        fakeService([
          campaignRow({ id: 'd', status: 'draft' }),
          campaignRow({ id: 'p', status: 'paused' }),
        ]),
      );
      const result = (await tool(tools, 'list_campaigns').handler(
        {},
        CTX,
      )) as ReferencePayload;
      const { needsAttention } = result.data as {
        needsAttention: { id: string; suggestedAction?: string }[];
      };

      expect(needsAttention[0].suggestedAction).toBe(
        'finish setup and launch it',
      );
      expect(needsAttention[1].suggestedAction).toBe(
        'resume it to start posting again',
      );
    });

    it('offers no action for a campaign that needs none', async () => {
      const tools = createCampaignTools(
        fakeService([campaignRow({ status: 'active' })]),
      );
      const result = (await tool(tools, 'list_campaigns').handler(
        {},
        CTX,
      )) as ReferencePayload;
      const { onTrack } = result.data as {
        onTrack: { suggestedAction?: string }[];
      };

      expect(onTrack[0].suggestedAction).toBeUndefined();
    });

    it('tells the chip which campaign type it is, so it wears the right icon', async () => {
      const tools = createCampaignTools(
        fakeService([campaignRow({ type: 'evergreen' })]),
      );
      const result = (await tool(tools, 'list_campaigns').handler(
        {},
        CTX,
      )) as ReferencePayload;

      // The raw id, not the label — the frontend maps it to the Campaigns
      // page's own icon.
      expect(result.refs[0].variant).toBe('evergreen');
    });

    it('carries the progress counts the user asks about', async () => {
      const tools = createCampaignTools(fakeService([campaignRow()]));
      const result = (await tool(tools, 'list_campaigns').handler(
        {},
        CTX,
      )) as ReferencePayload;
      const { onTrack } = result.data as {
        onTrack: { progress: Record<string, number> }[];
      };

      expect(onTrack[0].progress).toEqual({
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
