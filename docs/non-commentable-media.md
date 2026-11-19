# Media with no comments edge

One Instagram Story was polled for comments **20,169 times in seven days** —
every 30 seconds, forever. This is why, and what now stops it.

## The bug was the memory, not the handling

Meta answers `(#100) Tried accessing nonexisting field (comments)` for a Story,
a deleted post, or a media whose edge is not named `comments`. Both the
Facebook and Instagram pollers already recognised that and returned no comments
instead of failing the whole channel's poll. **That part was correct.**

What was missing: the caller could not tell _"this post has no comments yet"_
from _"this media can never have comments"_, because both arrived as an empty
array. So the inbox poller — which asks every recent post on every cycle —
asked the same Story again 30 seconds later, and again, and again.

The cost was not only the wasted calls against a rate-limited platform. Each
one wrote a row into `error_logs`, which is the table that reached **738MB and
2.17M rows** once already (BE #128). This single Story was **20,169 of the
38,419 rows** on production, over seven days.

## Found by sweeping production, not by a report

Nobody noticed. It was found by grouping `error_logs` by context while
investigating something else:

```sql
SELECT context, left(message, 90), count(*)
FROM error_logs GROUP BY 1,2 ORDER BY 3 DESC;
```

One row, one media id, 20,169 times.

## The shape of the fix

A typed error instead of an empty array, caught at the only two call sites
that exist:

```
service          throws NonCommentableMediaError
  ↓
inbox adapter    (passes through)
  ↓
poll processor   records it, then skips that media on every later cycle
```

`nonCommentableReason(status, errorText)` decides what counts. The two services
carried **byte-identical** inline checks for this — same three patterns, same
status — so they are now one function. Two copies of a rule is one copy that
will drift.

### What is deliberately NOT treated as permanent

Only a **400** carrying `(#100)` / `nonexisting field` / `(#803) aliases …`.
A rate limit, an expired token or a 500 keeps today's behaviour: logged and
retried.

That boundary is the dangerous part of this change. Recording a transient
failure as permanent would stop polling a **real** post for good — far worse
than the bug being fixed — so two tests exist purely to pin it, and the
mutations that widen the matcher fail them.

## Why a table

`inbox_non_commentable_media`, keyed `(channel_id, platform_post_id)`, written
with `ON CONFLICT DO NOTHING` (migration `0090`).

**Not `posts.targets`.** Every writer of that jsonb reads the whole array,
changes one entry and writes it back — the publish path, the pause and
disconnect sweeps, the composer. A poller writing there would race them and the
loser's write would vanish with no error. That is the read-modify-write bug
that silently lost a seat on the usage counters (BE #245).

**Not Redis.** "This media has no comments edge" is a **permanent** fact: a
Story will never become commentable, a deleted post will not come back. Redis
holds things that expire, and a TTL here means relearning the fact — at 20,169
calls — every time the key is evicted or Redis is flushed.

The `channel_id` foreign key cascades: disconnecting a channel makes every row
about its media meaningless. `platform_post_id` is **not** a foreign key to
`posts`, because one media can be reached from several post rows and a post can
be hard-deleted while the media still exists on the platform.

## Fail-open

`NonCommentableMediaService` swallows its own errors in both directions. A
failed read polls a Story it could have skipped — today's behaviour. A failed
write costs one more poll next cycle. Neither may stop comment ingestion, which
is the same direction the YouTube budget gate already chose in the same file,
for the same stated reason: _"polling nothing degrades silently"_.

## Tests

`non-commentable-media.spec.ts` (23), including a fail-closed net requiring
**both** services to use the shared matcher and neither to keep an inline copy.

| Mutation                                        | Tests that fail |
| ----------------------------------------------- | --------------- |
| drop the skip (record but keep polling)         | 1               |
| log it as an `error` again                      | 1               |
| treat **any** 400 as non-commentable            | 2               |
| drop the status check (a 429 becomes permanent) | 1               |

The last two matter most: both are ways of turning a transient failure into a
permanent one, which would quietly stop polling a real post.

### Two things the tests caught

**A comment that had become a lie.** The Facebook service still said _"log at
WARN and return what we have"_ above code that now throws. The net flagged it
because it matched the old regex text — a false positive on prose that turned
out to point at a real problem.

**And one of the tests was wrong.** The assertion that this branch does not log
an error sliced the file as far as a marker _below_ the generic handler, so it
swallowed **that** handler's `logger.error` and failed against correct code. It
now ends at the branch's own `continue;`, and a second test asserts the generic
handler **does** still log an error — so the fix cannot have made every failure
quiet.

### And the column type was wrong

The first version of the schema and the migration both declared `channel_id`
as `uuid`. `social_media_channels.id` is a **`bigserial`**, so that foreign key
would have failed on production the moment the migration ran.

Nothing in the test suite noticed — the service's own types were internally
consistent, and no test touches a real database. `npm run typecheck` caught it,
because the poll processor types `channelId` as a `number` and the service
wanted a `string`. **Jest does not typecheck; the build does.**

## Related, still open

The same production sweep found one inbox DM conversation failing repeatedly
(2,115 rows). Same shape — a permanently-failing thing retried every tick —
but a different path, so it is not bundled here.
