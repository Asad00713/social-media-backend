# One LinkedIn version pin

LinkedIn analytics had been returning nothing for about two and a half years
while LinkedIn publishing worked. This is what happened and what now stops it
recurring.

## The symptom

`error_logs` on production carried **12,473 rows in seven days** from
`PostMetricSnapshotHandler`, all of this shape:

```
Post snapshot failed postId=05180ebf-…: Requested version 20240201 is not active
```

Six posts, each failing **exactly ~2,097 times** — which is 7 days of a 5-minute
poll. Every tick, forever, never giving up.

## It took a wrong turn first

The error sat next to `graph.instagram.com` calls in the log, so the first
reading was "Instagram analytics is calling a retired API version". That was
wrong, and the way it was wrong is worth recording:

- **`20240201` is not a Meta version.** Meta uses `vNN.0` only — `v25.0`,
  `v27.0`. No date-style version exists anywhere in its scheme.
- The Meta App Dashboard showed **v25.0**, perfectly current, which killed the
  "the app is pinned to an old default" theory outright.
- Searching the source for `20240201` found **nothing**, which looked like
  evidence it came from Meta's side. It was actually the clue: we send
  `202402`, and **LinkedIn expands it to a date in its error text**.

Both platforms' analytics run from the same scheduler
(`channel-snapshots.scheduler.ts`), so their failures interleave in one log
stream. Proximity is not attribution.

## The actual bug

| File                                                    | Header value               |
| ------------------------------------------------------- | -------------------------- |
| `analytics/adapters/linkedin/linkedin-api.client.ts:73` | `'202402'` — February 2024 |
| `services/linkedin.service.ts:55`                       | `'202610'` — October 2026  |

LinkedIn requires `Linkedin-Version` on every `/rest` call (the latest is **not**
applied by default) and sunsets each monthly version after about a year.
`202402` was roughly 2.5 years past that, so LinkedIn answered every analytics
call with HTTP 426.

**Publishing worked the whole time.** Only analytics was dead, and only
silently — the failure surfaced as empty charts and log rows, never as an
error anyone saw.

## It had already happened once

`linkedin.service.ts` carries a comment from an earlier fix:

> _It used to call `/v2/posts` with a hard-coded `LinkedIn-Version: 202404`
> while every other format sent `LINKEDIN_REST_VERSION`._

Same failure, same file family, fixed once — and the analytics adapter was
missed, because nothing connected the two. That is the whole argument for what
follows.

## The fix: one pin, imported by both

`channels/lib/linkedin-version.ts` now exports `LINKEDIN_REST_VERSION` and
`LINKEDIN_VERSION_HEADER`. Both the analytics client and the publishing service
import them; neither declares its own.

A pinned API version is **a thing that expires**. A pin written down twice
expires in one place first, and the place that expires first is whichever one
nobody is looking at.

### Header casing

The analytics adapter sent `LinkedIn-Version`; publishing sends
`Linkedin-Version`, LinkedIn's own documented spelling. HTTP header names are
case-insensitive (RFC 9110) and LinkedIn accepts both — the adapter's only
problem was the stale value, not the casing. It is unified anyway so that **one
grep for the header finds every sender**, which is precisely what did not
happen last time.

## Tests

`channels/lib/linkedin-version.spec.ts` (8), written **fail-closed over the
source tree** rather than over a list of files someone remembers to update:

- every file under `src/channels` that sends the header must reference
  `LINKEDIN_REST_VERSION`;
- no file may carry a hard-coded `YYYYMM` next to the header — the exact shape
  of both past failures;
- the pin must parse as a real `YYYYMM` month;
- **the pin must not be more than 11 months old.** LinkedIn's stated support
  window is a minimum of 12 months, so this fails one month before the version
  can be sunset — leaving time to read the changelog and bump deliberately,
  rather than discovering it from a 426 in production.

That last test is the one that makes this self-correcting. The others stop a
new sender drifting; it stops the _shared_ pin drifting.

Mutation-tested:

| Mutation                               | Tests that fail |
| -------------------------------------- | --------------- |
| revert the adapter to `'202402'`       | 1               |
| set the shared pin to `'202402'`       | 1               |
| add a new file with its own `'202501'` | 2               |

### The net policed one file before it policed two

Written first to match the literal header name, it found **one** file and
reported success. The analytics client now writes
`headers[LINKEDIN_VERSION_HEADER] = …`, so the literal string no longer appears
in it at all — the net had quietly stopped policing the very file whose drift
caused this. It now matches the constant as well as the literal.

### And a test run that lied

The first check after the change reported **135 passed**. The two adapter
suites were not passing: they were **failing to compile** (a relative import
one level short), which Jest reports as `Tests: 0` on those suites while other
matching suites still report their own counts. Running the adapter directory
alone showed `Tests: 0 total` and the real error.

## Bumping it later

Read the changelog for the Posts, Images, Documents and Social Actions APIs
first — a version bump can change response shapes, not just the header. Then
change the one constant; the spec will tell you if anything has drifted away
from it.
