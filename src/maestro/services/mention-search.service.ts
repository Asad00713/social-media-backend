import { Injectable, Logger } from '@nestjs/common';
import { PostService } from '../../posts/services/post.service';
import { ChannelService } from '../../channels/services/channel.service';
import { CampaignsService } from '../../campaigns/campaigns.service';
import { InboxService } from '../../inbox/inbox.service';
import { WorkspaceMembersService } from '../../workspace-members/workspace-members.service';
import { MediaItemService } from '../../media-library/services/media-item.service';
import { TemplateService } from '../../media-library/services/template.service';
import { TextSnippetService } from '../../media-library/services/text-snippet.service';

/**
 * Everything the `@` picker can offer, grouped the way the picker shows it.
 *
 * Modelled on ClickUp's mention picker, measured in their live UI: `@` alone
 * opens the list with recent items already in it (never an empty box asking you
 * to type), typing filters, and each row carries a second line of context —
 * "Project 1 *in Team Space*" — because a bare name is ambiguous the moment two
 * things share one.
 */
export const MENTION_TYPES = [
  'post',
  'campaign',
  'channel',
  'template',
  'snippet',
  'media',
  'member',
  'conversation',
] as const;

export type MentionType = (typeof MENTION_TYPES)[number];

/** One row in the picker. */
export interface MentionResult {
  type: MentionType;
  id: string;
  label: string;
  /** Second line: what tells two same-named things apart. */
  context: string | null;
  /** Short state, shown as a pill — the same word the app uses elsewhere. */
  status?: string;
  /** Platform id when the row has a brand logo (channels, posts). */
  platform?: string;
}

/** How many rows one type contributes when nothing is typed yet. */
const RECENT_PER_TYPE = 4;
/** How many rows one type contributes to a filtered search. */
const SEARCH_PER_TYPE = 6;

function matches(haystack: string | null | undefined, needle: string): boolean {
  if (!needle) return true;
  return (haystack ?? '').toLowerCase().includes(needle);
}

/** A date as a short human phrase, for the context line. */
function shortDate(at: Date | string | null | undefined): string | null {
  if (!at) return null;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The first line of a post, which is how the user recognises it. */
function postLabel(content: unknown, fallback: string): string {
  const text =
    typeof content === 'string'
      ? content
      : ((content as { text?: string } | null)?.text ?? '');
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return fallback;
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

@Injectable()
export class MentionSearchService {
  private readonly logger = new Logger(MentionSearchService.name);

  constructor(
    private readonly posts: PostService,
    private readonly channels: ChannelService,
    private readonly campaigns: CampaignsService,
    private readonly inbox: InboxService,
    private readonly members: WorkspaceMembersService,
    private readonly mediaItems: MediaItemService,
    private readonly templates: TemplateService,
    private readonly snippets: TextSnippetService,
  ) {}

  /**
   * Rows for the picker, across every type or one of them.
   *
   * Each type is fetched independently and failures are swallowed per type: a
   * picker that renders nothing because ONE source is down is worse than a
   * picker missing one section, and the user has no way to tell which happened.
   */
  async search(params: {
    workspaceId: string;
    userId: string;
    query: string;
    type?: MentionType;
  }): Promise<{ results: MentionResult[] }> {
    const q = params.query.trim().toLowerCase();
    const limit = q ? SEARCH_PER_TYPE : RECENT_PER_TYPE;
    const wanted: readonly MentionType[] = params.type
      ? [params.type]
      : MENTION_TYPES;

    const settled = await Promise.all(
      wanted.map((type) =>
        this.forType(type, params.workspaceId, params.userId, q, limit).catch(
          (err) => {
            this.logger.warn(`mention search failed for ${type}: ${err}`);
            return [] as MentionResult[];
          },
        ),
      ),
    );

    return { results: settled.flat() };
  }

  private forType(
    type: MentionType,
    workspaceId: string,
    userId: string,
    q: string,
    limit: number,
  ): Promise<MentionResult[]> {
    switch (type) {
      case 'post':
        return this.searchPosts(workspaceId, q, limit);
      case 'campaign':
        return this.searchCampaigns(workspaceId, q, limit);
      case 'channel':
        return this.searchChannels(workspaceId, q, limit);
      case 'template':
        return this.searchTemplates(workspaceId, q, limit);
      case 'snippet':
        return this.searchSnippets(workspaceId, q, limit);
      case 'media':
        return this.searchMedia(workspaceId, q, limit);
      case 'member':
        return this.searchMembers(workspaceId, userId, q, limit);
      case 'conversation':
        return this.searchConversations(workspaceId, userId, q, limit);
    }
  }

  private async searchPosts(
    workspaceId: string,
    q: string,
    limit: number,
  ): Promise<MentionResult[]> {
    const { posts: rows } = await this.posts.getWorkspacePosts(workspaceId, {
      limit: 60,
    });

    return (rows as unknown as Record<string, unknown>[])
      .map((p) => ({
        row: p,
        label: postLabel(p.content, 'Untitled post'),
      }))
      .filter(({ label }) => matches(label, q))
      .slice(0, limit)
      .map(({ row, label }) => ({
        type: 'post' as const,
        id: String(row.id),
        label,
        context: shortDate(
          (row.scheduledAt ?? row.publishedAt ?? row.createdAt) as Date,
        ),
        status: typeof row.status === 'string' ? row.status : undefined,
      }));
  }

  private async searchCampaigns(
    workspaceId: string,
    q: string,
    limit: number,
  ): Promise<MentionResult[]> {
    const rows = await this.campaigns.list(workspaceId, {});
    return rows
      .filter((c) => matches(c.name, q))
      .slice(0, limit)
      .map((c) => ({
        type: 'campaign' as const,
        id: c.id,
        label: c.name,
        context: c.type === 'bulk' ? 'Simple campaign' : `${c.type} campaign`,
        status: c.status,
      }));
  }

  private async searchChannels(
    workspaceId: string,
    q: string,
    limit: number,
  ): Promise<MentionResult[]> {
    const rows = await this.channels.getWorkspaceChannels(workspaceId);
    return rows
      .filter((c) => matches(c.accountName ?? c.username, q))
      .slice(0, limit)
      .map((c) => ({
        type: 'channel' as const,
        id: String(c.id),
        label: c.accountName || c.username || 'Channel',
        context: c.username ? `@${c.username}` : c.platform,
        platform: c.platform,
        // A dead channel is exactly the one you must not silently @-mention
        // into a request, so its state travels with the row.
        status: c.isActive ? undefined : 'needs reconnect',
      }));
  }

  private async searchTemplates(
    workspaceId: string,
    q: string,
    limit: number,
  ): Promise<MentionResult[]> {
    const { items } = await this.templates.findAll(workspaceId, {
      search: q || undefined,
      limit,
    });
    return items.map((t) => ({
      type: 'template' as const,
      id: t.id,
      label: t.name,
      context: t.templateType ? `${t.templateType} template` : 'template',
    }));
  }

  private async searchSnippets(
    workspaceId: string,
    q: string,
    limit: number,
  ): Promise<MentionResult[]> {
    const { items } = await this.snippets.findAll(workspaceId, {
      search: q || undefined,
      limit,
    });
    return items.map((s) => ({
      type: 'snippet' as const,
      id: s.id,
      label: s.name,
      context: s.snippetType ? `${s.snippetType} snippet` : 'snippet',
    }));
  }

  private async searchMedia(
    workspaceId: string,
    q: string,
    limit: number,
  ): Promise<MentionResult[]> {
    const { items } = await this.mediaItems.findAll(workspaceId, {
      search: q || undefined,
      limit,
      sortBy: 'lastUsedAt',
      sortOrder: 'desc',
    });
    return items.map((m) => ({
      type: 'media' as const,
      id: m.id,
      label: m.name,
      context: m.type ?? 'file',
    }));
  }

  private async searchMembers(
    workspaceId: string,
    userId: string,
    q: string,
    limit: number,
  ): Promise<MentionResult[]> {
    const roster = await this.members.getMembers(workspaceId, userId);

    // The owner is a member of the workspace in every sense the user cares
    // about, but lives outside the members array — so they are folded in here
    // rather than being the one person you cannot mention.
    const rows: MentionResult[] = [];
    if (roster.owner) {
      rows.push({
        type: 'member',
        id: roster.owner.id,
        label: roster.owner.name ?? roster.owner.email,
        context: 'Owner',
      });
    }
    for (const m of roster.members) {
      const u = (m as { user?: { id: string; name: string | null; email: string } })
        .user;
      if (!u) continue;
      rows.push({
        type: 'member',
        id: u.id,
        label: u.name ?? u.email,
        context: (m as { role?: string }).role ?? 'Member',
      });
    }

    return rows.filter((r) => matches(r.label, q)).slice(0, limit);
  }

  private async searchConversations(
    workspaceId: string,
    userId: string,
    q: string,
    limit: number,
  ): Promise<MentionResult[]> {
    // DMs only. Comment threads are named by the post they hang off, so
    // mentioning one would read as mentioning the post — @-ing the post itself
    // is the clearer gesture, and it is already in the list.
    const { threads } = await this.inbox.listDmConversations(
      workspaceId,
      userId,
      { limit: 40 },
    );

    return threads
      .filter((t) =>
        matches(t.participant?.displayName ?? t.participant?.handle, q),
      )
      .slice(0, limit)
      .map((t) => ({
        type: 'conversation' as const,
        // `id` is the thread key the Inbox routes on — NOT conversationId,
        // which is the platform's own id and does not open anything.
        id: t.id,
        label:
          t.participant?.displayName ?? t.participant?.handle ?? 'Conversation',
        context: t.platform,
        platform: t.platform,
        status: t.status,
      }));
  }
}
