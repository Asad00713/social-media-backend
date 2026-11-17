# Soft delete

Deleting a workspace used to be final. One `DELETE` cascaded through 50
foreign-keyed tables — channels, campaigns, inbox, analytics, billing rows —
and the only way back was restoring the whole database.

Now the row is marked, and a nightly job removes it 30 days later.

---

## How it works

| | |
|---|---|
| **Columns** | `workspace.deleted_at`, `workspace.deleted_by_id` (migration 0088) |
| **Delete** | `WorkspaceService.deleteWorkspace` sets them; nothing is removed |
| **Purge** | `WorkspacePurgeService`, nightly 03:40 UTC, deletes rows past 30 days |
| **Retention** | `SOFT_DELETE_RETENTION_DAYS` — the same window the media library's recycle bin uses |

Everything else about deletion is unchanged: the workspace slot is released,
plan limits re-derive, pooled channels come back. To the user and to the rest
of the system the workspace is gone the moment the call returns. Only the rows
survive.

There is **no Bin UI**. This is a safety net, not a feature — a mistake can be
undone by hand within the window, which is what the production-readiness audit
asked for.

## Restoring one

Within 30 days, by clearing the two columns:

```sql
-- Find it (Railway → Postgres → Console)
SELECT id, name, owner_id, deleted_at
  FROM workspace
 WHERE deleted_at IS NOT NULL
 ORDER BY deleted_at DESC;

-- Bring it back
UPDATE workspace
   SET deleted_at = NULL, deleted_by_id = NULL
 WHERE id = '<uuid>';
```

Everything that cascaded is still attached, because nothing was ever removed.

Two things do **not** come back on their own:

- **The workspace slot.** Deleting released an `EXTRA_WORKSPACE` add-on if the
  account was over its included allowance. Restoring does not re-purchase it;
  check the account's billing if the workspace count now exceeds the plan.
- **Queued jobs** for anything scheduled inside it. The scheduled-post
  reconciler re-arms posts within its own 6-hour window, so a restore later
  than that leaves them failed as missed.

## The rule when writing a query

**Every read of `workspace` must exclude deleted rows.**

```ts
import { liveWorkspaces } from '../posts/soft-delete/soft-delete';

.where(and(eq(workspace.id, workspaceId), liveWorkspaces()))
```

Raw SQL: `AND w.deleted_at IS NULL`.

Drizzle's relational API is a second spelling of the same read and needs the
same filter:

```ts
this.db.query.workspace.findFirst({
  where: and(eq(workspace.id, workspaceId), liveWorkspaces()),
})
```

That form was invisible to the first version of the regression spec — 34 reads
of it went unnoticed until the spec learned to look for `.query.workspace.find`
as well as `.from(workspace)`. Worth remembering when widening this to `posts`.

Miss one and a deleted workspace reappears in the switcher, keeps counting
towards the plan, and keeps sending email.

`src/posts/soft-delete/reads-filter-deleted.spec.ts` discovers every read site
from disk on each run, so a query written next month is covered without anyone
remembering this document. The only way past it is an entry in
`reads-exempt-from-deleted-filter.ts`, which demands a reason. There are 44 read sites today across all three spellings, and two
exemptions.

## Posts are not done yet

Migration 0088 added the same columns to `posts`, and the helpers
(`livePosts`, `livePostsSql`) exist, but **the post delete path is still a
hard delete** and its reads are unfiltered.

That is deliberate. `posts` has ~49 read sites, and several carry product
decisions rather than mechanical edits:

- does a deleted post still count towards a plan's queued-post quota?
- do deleted posts leave analytics and insights totals, changing numbers the
  user already saw in a report?

The intended answer to the first is **no** — delete frees the slot
immediately, as Gmail, Dropbox and Figma all behave; a 30-day hold confuses
far more people than the theoretical quota loophole costs. But that is a
decision to make deliberately, with the analytics question alongside it, and
bundling it here would have made both halves harder to review.

To pick it up: widen `BUILDER_READ` and `RAW_READ` in the regression spec to
`(posts|workspace)` and work through what it reports. Nothing else in that
file needs changing — which is the point of discovering read sites from disk.
