import { z } from 'zod';
import type {
  CampaignsService,
  CampaignDto,
} from '../../campaigns/campaigns.service';
import type { AgentToolDefinition } from '../maestro.types';
import {
  REFERENCE_USAGE_HINT,
  withReferences,
  type EntityReference,
} from './references';

/**
 * Campaign statuses the UI knows how to colour. Kept in step with the
 * frontend's CAMPAIGN_STATUS_CONFIG: a status outside this set still renders,
 * but as a neutral pill rather than its own colour.
 */
const CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'active',
  'paused',
  'completed',
  'failed',
] as const;

/**
 * What each campaign type is CALLED in the product.
 *
 * `bulk` is the database's word; the user has never seen it — every screen
 * calls that type "Simple" (see the frontend's CAMPAIGN_TYPES). An agent that
 * says "bulk" is naming a thing that does not exist in the interface, which
 * reads as a fabricated attribute rather than a synonym.
 *
 * A type absent from this map passes through unchanged: a new type is better
 * named by its raw id than dropped from the answer.
 */
const CAMPAIGN_TYPE_LABEL: Record<string, string> = {
  bulk: 'Simple',
  drip: 'Drip',
  evergreen: 'Evergreen',
};

function typeLabel(type: string): string {
  return CAMPAIGN_TYPE_LABEL[type] ?? type;
}

/** How many campaigns one answer can name before the reply stops being useful. */
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

/**
 * A campaign's schedule window as a short phrase.
 *
 * Switched on the SCHEDULE's own discriminant rather than the campaign's `type`
 * column, because the union is what actually carries `endDate` — so the
 * compiler checks this rather than a cast hiding it. Evergreen has no end (it
 * rotates a pool forever) and a drip schedule may have none either, so neither
 * gets an end date invented for it.
 */
function scheduleSummary(c: CampaignDto): string | null {
  const schedule = c.schedule;
  if (!schedule) return null;

  if (schedule.type === 'evergreen') {
    return schedule.startDate
      ? `from ${schedule.startDate}, ongoing`
      : 'ongoing';
  }

  const { startDate, endDate } = schedule;
  if (startDate && endDate) return `${startDate} → ${endDate}`;
  if (startDate) return `from ${startDate}, no end date`;
  return null;
}

/**
 * The campaign's progress in the terms the user thinks in.
 *
 * `metrics` counts slots, which is what the campaign detail page shows. We pass
 * the raw counts through rather than pre-computing a percentage: a model given
 * "12 of 30" writes a better sentence than one given "40%".
 */
function progressOf(c: CampaignDto) {
  const m = c.metrics;
  return {
    planned: m.postsPlanned,
    published: m.postsPublished,
    failed: m.postsFailed,
    skipped: m.postsSkipped,
  };
}

/**
 * Whether this campaign is waiting on the user.
 *
 * A draft was never launched and a paused campaign was stopped by hand — both
 * sit still until someone acts. `failed` needs looking at for the opposite
 * reason. Everything else is either running or finished, so it needs nothing.
 *
 * Computed here rather than left to the model: "which ones need attention" is
 * the question users actually ask, and an answer that re-derives it from six
 * status strings gets it wrong eventually.
 */
function needsAttention(c: CampaignDto): boolean {
  return c.status === 'draft' || c.status === 'paused' || c.status === 'failed';
}

/**
 * The one thing the user would do about this campaign next.
 *
 * The status pill already shows the state, so the answer's prose has to earn
 * its place by saying what the state MEANS. Supplying the verb here keeps that
 * consistent instead of leaving the model to invent a phrasing per campaign.
 */
function suggestedAction(c: CampaignDto): string | null {
  switch (c.status) {
    case 'draft':
      return 'finish setup and launch it';
    case 'paused':
      return 'resume it to start posting again';
    case 'failed':
      return 'check what went wrong';
    default:
      return null;
  }
}

/** One campaign, flattened to what an answer actually needs. */
function summarize(c: CampaignDto) {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    // The product's word, not the database's — see CAMPAIGN_TYPE_LABEL.
    type: typeLabel(c.type),
    platforms: c.platforms,
    channelCount: c.channelIds.length,
    schedule: scheduleSummary(c),
    progress: progressOf(c),
    nextRunAt: c.nextRunAt,
    launchedAt: c.launchedAt,
    needsAttention: needsAttention(c),
    ...(suggestedAction(c) ? { suggestedAction: suggestedAction(c) } : {}),
  };
}

function referenceFor(c: CampaignDto): EntityReference {
  return {
    kind: 'campaign',
    id: c.id,
    label: c.name,
    status: c.status,
    // The raw type, not its label — the frontend maps this to the same icon the
    // Campaigns page draws on the card, so a chip looks like what it links to.
    variant: c.type,
  };
}

/**
 * Read-only tools over the workspace's campaigns.
 *
 * Two tools, not five: a list with filters answers "what campaigns do I have",
 * "which are running", and "anything failing"; a detail tool answers everything
 * about one. Splitting those into a tool per question would multiply the
 * model's choices without adding an answer it could not already give.
 *
 * Every read derives its workspace from `ctx` — never from tool arguments, so
 * the tenant boundary is enforced by shape rather than by instruction.
 */
export function createCampaignTools(
  campaigns: CampaignsService,
): AgentToolDefinition[] {
  return [
    {
      name: 'list_campaigns',
      description:
        'List this workspace\'s campaigns, optionally filtered by status or searched by name. Use this for "what campaigns do I have", "what\'s running right now", "any campaigns paused", or before suggesting the user schedule something. Covers all three types: Simple, Drip, and Evergreen.\n\n' +
        'The result arrives already split into `needsAttention` (drafts, paused, and failed — the ones waiting on the user) and `onTrack`. Lead your answer with that split: say how many need attention, name those first, and only then mention the ones running fine. Do not walk through every campaign in list order before reaching the point.\n\n' +
        'Each campaign carries a `suggestedAction` — the next thing the user would do. Use it instead of writing your own, and never explain what the status means ("it\'s in draft, so it hasn\'t started"): the chip shows the state, so your words are for what to do about it.\n\n' +
        "Do NOT write the campaign's type in your sentence — the chip already carries its type icon. `type` is there so you can filter or answer a direct question about it, not to be repeated beside every name." +
        REFERENCE_USAGE_HINT,
      inputSchema: {
        status: z
          .enum(CAMPAIGN_STATUSES)
          .optional()
          .describe(
            'Optional status filter. Omit to list campaigns in every state.',
          ),
        search: z
          .string()
          .optional()
          .describe(
            'Optional text to match against campaign name or description.',
          ),
        limit: z
          .number()
          .optional()
          .describe(
            `Max campaigns to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
          ),
      },
      handler: async (args, ctx) => {
        const status =
          typeof args.status === 'string' &&
          (CAMPAIGN_STATUSES as readonly string[]).includes(args.status)
            ? args.status
            : undefined;
        const search =
          typeof args.search === 'string' && args.search.trim()
            ? args.search.trim()
            : undefined;
        const limit = Math.min(
          Math.max(Number(args.limit) || DEFAULT_LIMIT, 1),
          MAX_LIMIT,
        );

        const all = await campaigns.list(ctx.workspaceId, {
          ...(status ? { status } : {}),
          ...(search ? { search } : {}),
        });

        // The service returns every match, newest first. Trim here rather than
        // in the query so `total` reports what actually exists — an answer that
        // says "you have 10 campaigns" when there are 40 is wrong.
        const page = all.slice(0, limit);

        // Split rather than hand back one flat list. "Which need attention" is
        // the question behind most campaign questions, and a result already
        // sorted into the two groups leads the model to answer with the
        // conclusion first instead of narrating every campaign in turn.
        const waiting = page.filter(needsAttention);
        const running = page.filter((c) => !needsAttention(c));

        return withReferences(
          {
            total: all.length,
            showing: page.length,
            ...(status ? { filteredByStatus: status } : {}),
            needsAttentionCount: waiting.length,
            onTrackCount: running.length,
            needsAttention: waiting.map(summarize),
            onTrack: running.map(summarize),
          },
          page.map(referenceFor),
        );
      },
    },

    {
      name: 'get_campaign',
      description:
        'Get one campaign in full: its status, type, schedule, the channels it posts to, and how many of its posts have gone out, failed, or been skipped. Use this when the user asks about a specific campaign by name or after list_campaigns narrowed it down.' +
        REFERENCE_USAGE_HINT,
      inputSchema: {
        campaignId: z.string().describe('The id of the campaign to fetch.'),
      },
      handler: async (args, ctx) => {
        const id =
          typeof args.campaignId === 'string' ? args.campaignId.trim() : '';
        if (!id) {
          return { error: 'A campaign id is required.' };
        }

        let campaign: CampaignDto;
        try {
          // getOne is workspace-scoped and throws NotFound for a campaign in
          // another tenant — which is the same answer as one that never
          // existed, and deliberately indistinguishable to the model.
          campaign = await campaigns.getOne(ctx.workspaceId, id);
        } catch {
          return { error: 'No campaign with that id in this workspace.' };
        }

        return withReferences(
          {
            campaign: {
              ...summarize(campaign),
              description: campaign.description,
              contentSource: campaign.contentSource,
              createdAt: campaign.createdAt,
            },
          },
          [referenceFor(campaign)],
        );
      },
    },
  ];
}
