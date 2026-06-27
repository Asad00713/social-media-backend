import { z } from 'zod';
import type { PostService } from '../../posts/services/post.service';
import type { AgentToolDefinition } from '../maestro.types';
import { confirmCard, isConfirmed } from './confirm';

/** Per-channel publish target stored on a post (jsonb). */
interface PostTargetLite {
  platform: string;
  status?: string;
  platformPostUrl?: string;
  errorMessage?: string;
}

type PostRow = Awaited<ReturnType<PostService['getPost']>>;

const LISTABLE_STATUSES = new Set([
  'draft',
  'scheduled',
  'published',
  'failed',
  'partially_published',
]);

function targetsOf(post: PostRow): PostTargetLite[] {
  return Array.isArray(post.targets) ? (post.targets as PostTargetLite[]) : [];
}

function platformsOf(post: PostRow): string[] {
  return [...new Set(targetsOf(post).map((t) => t.platform))];
}

function excerpt(text: string | null | undefined, n = 120): string {
  const s = (text ?? '').trim().replace(/\s+/g, ' ');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function mediaCount(post: PostRow): number {
  return Array.isArray(post.mediaItems) ? post.mediaItems.length : 0;
}

export function createPostTools(
  posts: PostService,
  opts: { confirmBeforeSend: boolean },
): AgentToolDefinition[] {
  const { confirmBeforeSend } = opts;
  return [
    {
      name: 'list_posts',
      description:
        "List the workspace's posts by status — use status 'draft' to find drafts the user can publish, 'scheduled' for upcoming, 'published' for recent. Read-only.",
      inputSchema: {
        status: z
          .enum(['draft', 'scheduled', 'published', 'failed', 'partially_published'])
          .optional()
          .describe("Which posts to list. Defaults to 'draft'."),
        limit: z.number().optional().describe('Max posts to return (1-20, default 10).'),
      },
      handler: async (args, ctx) => {
        const status =
          typeof args.status === 'string' && LISTABLE_STATUSES.has(args.status)
            ? (args.status as
                | 'draft'
                | 'scheduled'
                | 'published'
                | 'failed'
                | 'partially_published')
            : 'draft';
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);
        const { posts: rows, total } = await posts.getWorkspacePosts(
          ctx.workspaceId,
          { status, limit },
        );
        return {
          kind: 'post' as const,
          ok: true,
          action: 'list',
          status,
          total,
          posts: rows.map((p) => ({
            id: p.id,
            status: p.status,
            content: excerpt(p.content),
            platforms: platformsOf(p),
            mediaCount: mediaCount(p),
            scheduledAt: p.scheduledAt,
          })),
        };
      },
    },

    {
      name: 'get_post',
      description:
        'Get the full details of one post by id (content, target platforms, media, status). Read-only.',
      inputSchema: {
        postId: z.string().describe('The id of the post to fetch.'),
      },
      handler: async (args, ctx) => {
        try {
          const p = await posts.getPost(String(args.postId || ''), ctx.workspaceId);
          return {
            kind: 'post' as const,
            ok: true,
            action: 'detail',
            post: {
              id: p.id,
              status: p.status,
              content: p.content ?? '',
              platforms: platformsOf(p),
              mediaCount: mediaCount(p),
              scheduledAt: p.scheduledAt,
              publishedAt: p.publishedAt,
              targets: targetsOf(p).map((t) => ({
                platform: t.platform,
                status: t.status,
                url: t.platformPostUrl,
              })),
            },
          };
        } catch {
          return { kind: 'post' as const, ok: false, message: 'Post not found.' };
        }
      },
    },

    {
      name: 'publish_post',
      description:
        "Publish a draft post NOW to its configured target channels. OUTWARD-FACING — it posts publicly. Reports per-platform success/failure. Doesn't change which platforms the draft targets; if the user wants different platforms, tell them that's a draft edit.",
      inputSchema: {
        postId: z.string().describe('The id of the draft post to publish.'),
        confirmed: z
          .boolean()
          .optional()
          .describe(
            'Leave UNSET on your first call. Only set to true when re-calling this tool after the user approved the confirmation prompt.',
          ),
      },
      handler: async (args, ctx) => {
        let post: PostRow;
        try {
          post = await posts.getPost(String(args.postId || ''), ctx.workspaceId);
        } catch {
          return { kind: 'post' as const, ok: false, message: 'Post not found.' };
        }

        if (post.status === 'published') {
          return {
            kind: 'post' as const,
            ok: false,
            message: 'This post is already published.',
          };
        }
        if (post.status === 'publishing') {
          return {
            kind: 'post' as const,
            ok: false,
            message: 'This post is already being published.',
          };
        }
        const hasContent = Boolean((post.content ?? '').trim()) || mediaCount(post) > 0;
        if (!hasContent) {
          return {
            kind: 'post' as const,
            ok: false,
            message: 'The draft is empty — add some text or media before publishing.',
          };
        }
        if (targetsOf(post).length === 0) {
          return {
            kind: 'post' as const,
            ok: false,
            message: 'This draft has no target channels. Add at least one before publishing.',
          };
        }

        if (!isConfirmed(confirmBeforeSend, args)) {
          return confirmCard(
            `Publish this post now to ${platformsOf(post).join(', ')}?\n\n"${excerpt(
              post.content,
            )}"`,
            'Yes, publish',
          );
        }

        const result = await posts.publishPost(
          String(args.postId),
          ctx.workspaceId,
          ctx.userId,
          { triggeredBy: 'user' },
        );

        return {
          kind: 'post' as const,
          ok: true,
          action: 'published',
          status: result.status,
          results: targetsOf(result).map((t) => ({
            platform: t.platform,
            status: t.status,
            url: t.platformPostUrl,
            error: t.errorMessage,
          })),
        };
      },
    },
  ];
}
