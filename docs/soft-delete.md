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

## Access control

`WorkspaceSuspendedGuard` is the one place a deleted workspace is refused: it
reads `deleted_at` and answers **404** for every workspace-scoped route.

It deliberately does **not** filter deleted rows out of its own query. A
filtered query returns no row, and "no row" is that guard's signal that there
is nothing to enforce — so it would wave the request straight through.

This matters more than it looks. The membership checks scattered across the
app (`inbox.service.ts`, `scheduled-messages.service.ts`,
`analytics-events.gateway.ts`, `WorkspaceRoleService` and others) read
`workspace_invitation`, not `workspace` — they cannot see that a workspace was
deleted. Without the guard, an accepted member would keep full access to a
workspace its owner had deleted, while the owner themselves was correctly shut
out. Closing it in the guard fixes all of them at once.

## Posts

Same columns, same 30-day window, same purge pattern (`PostPurgeService`,
nightly 03:50 UTC). `PostService.deletePost` and the composer's discard-draft
both mark the row; the publish processor refuses a deleted post, so one that
was scheduled cannot go out after it was deleted.

### The rule: what you manage is hidden, what happened is kept

A post that published reached a platform, people saw it, the engagement was
real. Deleting it in Schedura means *"I don't want this in my list any more"*,
not *"this never happened"*.

| Reads | Deleted posts |
|---|---|
| Planner, Composer, drafts, channel page, queue limits, scheduling | **hidden** |
| Analytics, Insights, performance, platform status | **still counted** |

Filtering the measurement side would move last month's numbers when someone
tidies up their Planner, and a report they already read or shared would quietly
disagree with itself. That asymmetry is deliberate, it is written down in
`reads-exempt-from-deleted-filter.ts` against each exempt file, and
`posts.soft-delete.spec.ts` fails if someone "fixes" analytics to filter.

Proved on a real database, in a transaction:

```
published posts in workspace: 3
after soft delete -> analytics still sees: 3
                  -> planner/quota sees : 2
after restore     -> planner sees again: 3
```

### Restoring a post

```sql
SELECT id, content, status, deleted_at FROM posts
 WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC;

UPDATE posts SET deleted_at = NULL, deleted_by_id = NULL WHERE id = '<uuid>';
```

A post restored in `scheduled` state has no queued job — it was cancelled on
delete. The scheduled-post reconciler re-arms it within its 6-hour window;
past that it is failed as missed, which is the same rule any unarmed scheduled
post follows.

### What is still a hard delete, on purpose

System-generated rows that are *un-materialised* rather than deleted: a
campaign slot being reset (`campaigns.service.ts`), an evergreen occurrence
cancelled (`evergreen.service.ts`), posts stripped when a channel is removed
(`channel-posts-cleanup.service.ts`). The user never created those rows, so
there is nothing for them to restore.
