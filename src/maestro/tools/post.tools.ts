import { z } from 'zod';
import type { PostService } from '../../posts/services/post.service';
import type { AgentToolDefinition } from '../maestro.types';
import { confirmCard, isConfirmed } from './confirm';
import {
  REFERENCE_USAGE_HINT,
  withReferences,
  type EntityReference,
} from './references';

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

/**
 * Read a post id out of tool arguments.
 *
 * Zod validates these, but a handler is also reachable from the approval path
 * with stored arguments, so it coerces defensively rather than stringifying
 * whatever arrived — `String({})` is the string "[object Object]", which would
 * become a lookup for a post whose id is literally that.
 */
function postIdArg(args: Record<string, unknown>): string {
  return typeof args.postId === 'string' ? args.postId.trim() : '';
}

/**
 * The text a post is known by.
 *
 * A post has no name, so its chip has to carry something the user recognises —
 * and it must be the SAME something the Planner shows, or the agent will name a
 * post the user cannot find. This mirrors the frontend's
 * `getPostDisplayCaption`: body content first, then the platform-specific title
 * that title-only platforms (YouTube, Pinterest, Reddit) keep in
 * platformContent instead of `content`, then a per-platform body override.
 */
function displayCaption(post: PostRow): string | null {
  const body = (post.content ?? '').trim();
  if (body) return body;

  const platformContent = (post.platformContent ?? {}) as Record<
    string,
    | {
        text?: string;
        metadata?: { title?: string; description?: string };
        platformSpecific?: { title?: string; description?: string };
        overrides?: { text?: string };
      }
    | undefined
  >;

  for (const target of targetsOf(post)) {
    const pc = platformContent[target.platform];
    if (!pc) continue;

    // The composer writes per-platform settings under `platformSpecific`;
    // older posts wrote them under `metadata`. Both are live in the data.
    const fields = pc.platformSpecific ?? pc.metadata ?? {};

    if (
      target.platform === 'pinterest' ||
      target.platform === 'youtube' ||
      target.platform === 'reddit'
    ) {
      const title = fields.title?.trim();
      if (title) return title;
      const description = fields.description?.trim();
      if (description) return description;
    }

    const override =
      pc.overrides?.text?.trim() ??
      (typeof pc.text === 'string' ? pc.text.trim() : '');
    if (override) return override;
  }

  return null;
}

/**
 * A short label for a post's chip.
 *
 * Much shorter than the excerpt the model reads: a chip sits inside a sentence,
 * so a full caption would push the surrounding prose off the line. The model
 * still gets the longer excerpt in the tool result to reason about.
 */
function chipLabel(post: PostRow): string {
  const caption = displayCaption(post);
  if (!caption) return 'Untitled post';
  const oneLine = caption.replace(/\s+/g, ' ').trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 40).trimEnd()}…` : oneLine;
}

function referenceFor(post: PostRow): EntityReference {
  return {
    // A draft routes to the same editor as any other post, but the frontend
    // colours the two differently, so the kind has to reflect the real state.
    kind: post.status === 'draft' ? 'draft' : 'post',
    id: post.id,
    label: chipLabel(post),
    status: post.status,
    // A post can target several platforms; the chip shows one logo, so it gets
    // the first. Multi-platform posts read as that platform's post in the UI
    // too, so this matches what the user already sees.
    ...(platformsOf(post)[0] ? { platform: platformsOf(post)[0] } : {}),
  };
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
        "List the workspace's posts by status — use status 'draft' to find drafts the user can publish, 'scheduled' for upcoming, 'published' for recent. Read-only." +
        REFERENCE_USAGE_HINT,
      inputSchema: {
        status: z
          .enum([
            'draft',
            'scheduled',
            'published',
            'failed',
            'partially_published',
          ])
          .optional()
          .describe("Which posts to list. Defaults to 'draft'."),
        limit: z
          .number()
          .optional()
          .describe('Max posts to return (1-20, default 10).'),
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
        return withReferences(
          {
            kind: 'post' as const,
            ok: true,
            action: 'list',
            status,
            total,
            posts: rows.map((p) => ({
              id: p.id,
              status: p.status,
              content: excerpt(displayCaption(p)),
              platforms: platformsOf(p),
              mediaCount: mediaCount(p),
              scheduledAt: p.scheduledAt,
            })),
          },
          rows.map(referenceFor),
        );
      },
    },

    {
      name: 'get_post',
      description:
        'Get the full details of one post by id (content, target platforms, media, status). Read-only.' +
        REFERENCE_USAGE_HINT,
      inputSchema: {
        postId: z.string().describe('The id of the post to fetch.'),
      },
      handler: async (args, ctx) => {
        try {
          const p = await posts.getPost(postIdArg(args), ctx.workspaceId);
          return withReferences(
            {
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
            },
            [referenceFor(p)],
          );
        } catch {
          return {
            kind: 'post' as const,
            ok: false,
            message: 'Post not found.',
          };
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
          post = await posts.getPost(postIdArg(args), ctx.workspaceId);
        } catch {
          return {
            kind: 'post' as const,
            ok: false,
            message: 'Post not found.',
          };
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
        const hasContent =
          Boolean((post.content ?? '').trim()) || mediaCount(post) > 0;
        if (!hasContent) {
          return {
            kind: 'post' as const,
            ok: false,
            message:
              'The draft is empty — add some text or media before publishing.',
          };
        }
        if (targetsOf(post).length === 0) {
          return {
            kind: 'post' as const,
            ok: false,
            message:
              'This draft has no target channels. Add at least one before publishing.',
          };
        }

        if (!isConfirmed(confirmBeforeSend, args)) {
          return confirmCard(
            // displayCaption, not post.content: a YouTube/Pinterest post keeps
            // its title in platformContent, and confirming an empty quotation
            // gives the user nothing to recognise the post by.
            `Publish this post now to ${platformsOf(post).join(', ')}?\n\n"${excerpt(
              displayCaption(post),
            )}"`,
            'Yes, publish',
          );
        }

        const result = await posts.publishPost(
          postIdArg(args),
          ctx.workspaceId,
          ctx.userId,
          { triggeredBy: 'user' },
        );

        return withReferences(
          {
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
          },
          // The reference carries the POST-publish row, so the chip shows the
          // status the publish actually reached (published, or partial when a
          // platform failed) rather than the draft state it started in.
          [referenceFor(result)],
        );
      },
    },
  ];
}
