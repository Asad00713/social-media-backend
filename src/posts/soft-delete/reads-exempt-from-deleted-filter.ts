/**
 * Reads of `posts` or `workspace` that may legitimately see soft-deleted rows.
 *
 * Every other read must filter them out, or a post the author deleted
 * reappears in their Planner and a deleted workspace comes back in the
 * switcher, still counting towards their plan. The regression test discovers
 * read sites from disk, so a new one is covered the moment it is written —
 * and the only way past it is an entry here, with a reason.
 *
 * ## The rule the `posts` exemptions follow
 *
 * **What the user manages is hidden; what actually happened is kept.**
 *
 * A post that published reached a platform, people saw it, and the engagement
 * was real. Deleting it in Schedura means "I don't want this in my list any
 * more", not "this never happened" — so analytics, insights, performance and
 * platform status keep counting it. The alternative is worse: last month's
 * numbers would move when someone tidies up their Planner, and a report they
 * already read or shared would quietly disagree with itself.
 *
 * Everything the user *manages* — Planner, Composer, drafts, queue limits,
 * scheduling — hides deleted posts, because that is the list they just acted on.
 *
 * Keys are `relative/path.ts`. A file is exempt in full, so this belongs only
 * on small, single-purpose files where every read is deliberate. A file that
 * mixes both kinds should filter by default and ask for deleted rows
 * explicitly where it needs them.
 */
export const READS_EXEMPT_FROM_DELETED_FILTER: Record<string, string> = {
  // ─── Measurement: a published post stays counted ───────────────────────

  'src/channels/analytics/services/analytics.service.ts':
    'Counts posts that actually published. Filtering would move last month’s numbers when someone tidies up their Planner.',

  'src/channels/analytics/handlers/post-metric-snapshot.handler.ts':
    'Collects platform metrics for posts that went live; the platform post still exists whatever we do with our row.',

  'src/channels/analytics/handlers/channel-recent-posts-sync.handler.ts':
    'Matches platform posts back to ours, deleted ones included — otherwise the same platform post is re-imported as a new one.',

  'src/post-performance/post-performance.repository.ts':
    'Performance of posts that published. Same reasoning as analytics.service.',

  'src/insights/insights-topics.repository.ts':
    'Derives topics from the media of posts an insights query already selected; excluding them would silently drop rows from a report.',

  'src/platform-status/platform-status.repository.ts':
    'Measures publish success and lag per platform. A deleted post’s publish attempt still happened, and still says something about the platform.',

  'src/inbox/conversations/services/conversation-detail.service.ts':
    'Shows the post a comment was left on. The comment is still live on the platform and the reply box still works, so hiding the caption would leave the reader looking at a reply with no context.',

  // ─── Housekeeping: must see every row, deleted ones included ───────────

  'src/posts/services/post-purge.service.ts':
    'The purge job: finding soft-deleted posts is its entire purpose.',

  'src/workspace/workspace-purge.service.ts':
    'The purge job for workspaces: same.',

  'src/channels/services/channel-posts-cleanup.service.ts':
    'Strips a disconnected channel from posts, deleted ones included — a target left behind would publish if the post were restored.',

  'src/media-library/lib/usage-sql.ts':
    'Decides whether a media item is still referenced. A deleted post can be restored for 30 days, so its media must not be reported unused and purged meanwhile.',

  'src/media-library/services/media-usage.service.ts':
    'Same: media referenced by a deleted post is still spoken for until that post is purged.',

  'src/media-library/scripts/backfill-library-refs.ts':
    'A one-off backfill over every historical row; skipping deleted posts would leave them unbackfilled if restored.',

  'src/media-library/scripts/migrate-documents-to-r2.ts':
    'A one-off migration of stored files; a deleted post’s media still has to move, or restoring it would point at nothing.',

  // ─── The guard, and the fixtures ───────────────────────────────────────

  'src/auth/guards/workspace-suspended.guard.ts':
    'Reads deleted_at on purpose and answers 404. Filtering here would make a deleted workspace return no row, which this guard treats as "nothing to enforce" — it would wave the request through, and the membership checks downstream read workspaceInvitation rather than workspace.',

  'src/inbox/testing/inbox-db.ts':
    'A test fixture that seeds rows against a workspace it just created, so it cannot encounter a deleted one.',
};
