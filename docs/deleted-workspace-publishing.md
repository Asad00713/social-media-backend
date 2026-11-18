# A deleted workspace must stop publishing

Found while verifying Phase 2 audit item #5 ("cancel BullMQ jobs on
channel/workspace delete"). The channel half of that item turned out to be
already done; this is what looking at the workspace half uncovered, and it is
worse than a leftover job.

## The defect

Deleting a workspace is a **soft** delete. `workspace.service.ts` marks the
`workspace` row and nothing else:

```ts
await this.db.update(workspace)
  .set({ deletedAt: new Date(), deletedById: userId })
  .where(and(eq(workspace.id, workspaceId), liveWorkspaces()));
```

Posts keep `deleted_at IS NULL`, deliberately — the 30-day window exists so the
whole workspace can be brought back intact, and cascading the delete into posts
would make that restore lossy.

So a scheduled post in a deleted workspace is still a **live post**, and
`livePosts()` alone selects it happily. Proven against the database:

```
workspace live    -> filter selects:    3
workspace DELETED -> livePosts() only:  3   <- these still publish
workspace DELETED -> with the guard:    0
```

For a read answering a user's request, that gap is harmless: the routing
already scopes it to a workspace they can reach, and a deleted one is
unreachable. **The background paths are the problem**, because nothing scopes
them — `grep -c "eq(posts.workspaceId"` returns `0` in every one of them:

| Engine | Why it matters | How it is guarded |
|---|---|---|
| `post-publish.processor.ts` | the job that actually sends | `liveWorkspacePosts()` on its post read |
| `scheduled-post-reconciler.service.ts` | re-arms posts whose Redis job vanished, so it **recreates** jobs | `liveWorkspacePosts()` on its candidate scan |
| `repeat-posts.service.ts` | spawns the next post of a repeating series | `isWorkspaceLive()` early return |
| `campaigns/evergreen.service.ts` | daily cron that **materialises** `posts` rows and sends them | `liveWorkspaces()` join in `reconcile`, `isWorkspaceLive()` in `fireOccurrence` |
| `drips/processors/drip.processor.ts` | calls `publishPost` **directly** — never passes through the processor | `isWorkspaceLive()` before the row is created, plus the `getPost` guard |
| `posts/services/post.service.ts` | `getPost` is the only read `publishPost` does | `liveWorkspacePosts()` — the chokepoint for every direct-publish caller |

The result: a workspace someone deleted goes on **publishing to social media in
their name** until the purge job removes it 30 days later. The reconciler makes
it self-healing in the wrong direction — jobs that would have drained out of
Redis get re-armed — and the evergreen cron keeps minting fresh `posts` rows.

Cancelling the queued jobs on delete would not have been enough on its own,
which is why the audit's framing was incomplete: the reconciler would simply
put them back.

### Two engines were missed on the first pass

The first version of this change guarded four files under `src/posts` and
claimed completeness. **Evergreen recycling and drip campaigns bypassed all of
it**, because neither touches those reads — evergreen materialises its own
posts on a daily cron, and drips call `PostService.publishPost` directly, so
the publish processor's guard was never in their path. A drip post in a
soft-deleted workspace published to the platform for real. Both are
channel-aware (`liveChannel()`) and were workspace-blind — the same shape as
the `posts` blind spot this whole document is about.

The `stranded-post-sweeper` was also guarded on that pass, and should not have
been: it **never publishes**. Its own header says so, and reading `resolve()`
confirms it — it only writes bookkeeping from `post_history`. Guarding it
removed legitimate repair (rows stay `publishing` forever) and bought no
safety, so that guard was reverted.

## The fix

One filter beside `livePosts()` on the reads, and an early return on the paths
that CREATE posts:

```ts
export function liveWorkspacePosts(): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${workspace}
    WHERE ${workspace.id} = ${posts.workspaceId}
      AND ${workspace.deletedAt} IS NULL
  )`;
}
```

A correlated `EXISTS` rather than a join, because those queries have different
shapes — one aggregates, one selects a column list, one is a single-row lookup
— and a join would change what each returns and how its callers read it. This
drops into the existing `and(...)` unchanged. `posts.workspace_id` is
`NOT NULL`, so there is no orphan case to decide.

### Restore is a contract, not current behaviour

**There is no workspace restore in the codebase.** `grep -rn "deletedAt: null"
src/workspace` returns nothing, and the only `restore` reference is a comment
in `workspace-purge.service.ts` describing a hypothetical one. Today the soft
delete is really a 30-day-delayed hard delete; the restore path is the reason
it was built that way, not something that exists.

So this section states what restore will have to honour, rather than what
happens now.

Because every guard here asks the question live, clearing `deleted_at` makes
posts publishable again with no extra bookkeeping. Two cases then need care:

- A post whose time passed during the window is handled by machinery that
  already exists: the reconciler fails it as missed once `lateBy >
  PUBLISH_LATE_GRACE_MS` (6h), and tells the author.
- **A post held by user action is not.** The reconciler skips any post with a
  `channel_paused` or `channel_disconnected` target by design
  (`isHeldByUserAction`), and those holds are released only by
  `ChannelPauseService.resume` / `releaseAfterReconnect` — both of which take a
  `workspaceId` from a user request. Nothing re-triggers either after a
  restore, so such a post sits `scheduled` and held, the reconciler declines it
  on purpose, and nobody is told. Whoever builds restore has to release those
  holds or surface them.

### Cost

The plan is a semi-join on the workspace primary key, evaluated only for rows
that already passed the posts filter:

```
Nested Loop
  ->  <posts filter>
  ->  Seq Scan on workspace w   (never executed)
```

`never executed` because no post survived the filter in the sample. The
subquery cannot run more often than the outer query returns rows, and it probes
a primary key.

## Tests

`publishing-paths-skip-deleted-workspaces.spec.ts` (14 tests). A separate net
from `reads-filter-deleted.spec.ts`: that one asks *"does this read filter
deleted posts"*, which every file here passed while this bug was live. This one
asks the question that was missed — on a path that runs with no user, is the
post's **workspace** still there?

**The net is discovered, not a list.** The first version carried a
hand-maintained list of four files under `src/posts` and passed 14/14 while two
whole engines published unguarded. Its stated defence — *"you cannot infer
intent from disk"* — was half right: intent cannot be inferred, but
**capability can be enumerated**, and capability is the property that matters.

So the default is now fail-closed. Any file that enqueues a publish job, calls
`publishPost`, calls `materializeAndEnqueue`, or inserts a `posts` row already
`scheduled` must either carry a guard or appear in an explicit allowlist with a
reason. A new engine anywhere under `src/` fails the spec until someone decides
which it is. Run today it finds the publishers, and the allowlist holds six
entries — the Publish-now route and the agent tools (both user-scoped),
`held-targets.ts` (a pure helper), and three campaign/composer paths whose
callers decide liveness.

### The spec had the same bug it was written to catch

Mutation-testing it: removing the drip guard left **14/14 green**.
`drip.processor.ts` uses `liveWorkspaces()` once — for a *timezone lookup* that
feeds an email — so a guard regex that accepted it matched the file while its
publish path was wide open. `liveWorkspaces()` is a bare SQL fragment used all
over the codebase for ordinary scoped reads; only the two purpose-built guards
mean "this workspace may be published to". Narrowing the pattern to
`liveWorkspacePosts()` / `isWorkspaceLive()` makes that mutation fail 2 tests.

### Test fakes had to change too

Three suites failed once the guards landed, all for the same reason: their
fakes had no `workspace` row, so the guard read "deleted" and every publish
test skipped. That failure was itself evidence the guards work. Two needed
more:

- `evergreen-lifecycle.spec.ts` — its fake had no `innerJoin`, so the scoped
  sweep returned nothing. Added, and verified by mutation: marking the fixture
  workspace deleted fails 2 tests, so the join is really enforced.
- `repeat-posts.service.spec.ts` — its fake was **positional** ("first select
  is the timezone, second is the row"), which broke the moment a third read
  appeared ahead of them. Re-keyed on the table, so adding or reordering a read
  cannot silently shift what each one receives.

Mutation-tested:

| Mutation | Tests that fail |
|---|---|
| revert evergreen `reconcile` to the unscoped sweep | 1 |
| remove the drip workspace guard | 2 |
| remove the `repeat-posts` early return | 3 |
| drop the subquery's correlation | 1 |
| mark the fixture workspace deleted (lifecycle) | 2 |

The correlation one matters most: an uncorrelated `EXISTS` is true whenever
*any* live workspace exists, so it filters nothing while looking correct.
