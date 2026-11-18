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

| Path | Why it matters |
|---|---|
| `post-publish.processor.ts` | the job that actually sends |
| `scheduled-post-reconciler.service.ts` | re-arms posts whose Redis job vanished, so it **recreates** jobs |
| `stranded-post-sweeper.service.ts` | recovers posts stuck in `publishing` (two reads) |
| `repeat-posts.service.ts` | schedules the next post of a repeating series |

The result: a workspace someone deleted goes on **publishing to social media in
their name** until the purge job removes it 30 days later. And the reconciler
makes it self-healing in the wrong direction — jobs that would have drained out
of Redis get re-armed, and a repeating series keeps spawning new posts.

Cancelling the queued jobs on delete would not have been enough on its own,
which is why the audit's framing was incomplete: the reconciler would simply
put them back.

## The fix

One new filter beside `livePosts()` on those four paths:

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

Restoring a workspace clears `deleted_at`, so its posts become publishable
again with no extra bookkeeping: the filter asks the question live, each time.
A post whose time passed while the workspace was deleted is then handled by the
machinery that already exists for that — `PUBLISH_LATE_GRACE_MS` and the
reconciler's missed-post path.

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
deleted posts"*, which all four files passed while this bug was live. This one
asks the question that was missed — on a path that runs with no user, is the
post's **workspace** still there?

The list of paths is explicit rather than discovered from disk. "Reads posts"
is a property of a file; "publishes with no user to scope it" is a property of
its purpose, which no pattern can read off disk — and guessing wrong in the
permissive direction is how the first sweep missed this. The spec asserts a
guard per read (not merely one per file), that each sits in the same `and(...)`
as its `livePosts()`, and that the subquery is correlated.

Mutation-tested:

| Mutation | Tests that fail |
|---|---|
| guard only one of the sweeper's two reads | 2 |
| drop the subquery's correlation (filters nothing) | 1 |

The second matters most: an uncorrelated `EXISTS` is true whenever *any* live
workspace exists, so it would filter nothing while looking correct.
