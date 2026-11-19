# Request body limits and the free-form JSON corners

Phase 3 audit item #3 ("body-size limit + `@MaxLength`/`@ValidateNested`"). The
audit pointed at a file nothing imports, and the two defects that actually
exist are both worse than an unbounded string.

## What the audit said, and what was really there

> `content: string` has only `@IsString() @IsNotEmpty()`

That is `src/posts/dto/create-post.dto.ts`, and **nothing imports it**
(`grep -rn "create-post.dto" src` → no hits). The live DTO is
`src/posts/dto/post.dto.ts`, reached through `posts.controller.ts`, and it
already carried `@ValidateNested` with `@Type` on `mediaItems`. The dead file
has been deleted.

What the audit missed is below. Both were measured, not inferred — each was a
payload the server accepted before this change, with the global pipe's
`whitelist` and `forbidNonWhitelisted` both on.

## Defect 1: `PlatformContentDto` was declared and never validated

`platformContent` is where a post's per-platform captions live — the field that
decides what each channel actually publishes.

```ts
@IsOptional()
@IsObject()
platformContent?: Partial<Record<SupportedPlatform, PlatformContentDto>>;
```

`@IsObject()` asks only _"is this a non-null object"_. The `PlatformContentDto`
in the type is documentation: nothing validates against it.

`@ValidateNested()` cannot fix it either, which is why this is not a one-line
change. `ValidateNested` validates an object's **own properties**, and here
those properties are platform names (`twitter`, `facebook`), not the fields
(`text`, `mediaItems`). There is no built-in for "every value of this record".

Accepted before, zero errors:

```json
{ "twitter": { "text": 12345, "junkField": "x", "mediaItems": "not-an-array" } }
```

So a caption could arrive as a number, an unknown field could ride along into
the `targets` jsonb, and `mediaItems` could be a string where the publisher
expects an array.

### The fix

`EachValueOf(dto, allowedKeys)` in `src/common/validation/bounded-json.ts`
validates each **value** against the DTO and requires each **key** to be a real
platform, applying the same `whitelist` + `forbidNonWhitelisted` strictness the
global pipe gives a top-level body. It follows the repo's existing
`@ValidatorConstraint` + `@Validate` convention (see
`inbox/dto/create-scheduled-message.dto.ts`).

## Defect 2: a deep body crashed the process, and no size limit stops it

A 5,000-deep `metadata` object threw:

```
RangeError: Maximum call stack size exceeded
  at TransformOperationExecutor.transform (class-transformer)
```

Two things make this one awkward:

- **A body-size limit does not prevent it.** The payload is a few hundred
  kilobytes of text — comfortably inside any sane ceiling. V8's `JSON.parse`
  is iterative, so the body parses without complaint and the overflow lands
  later, in our own stack.
- **A field-level validator cannot catch it.** This was tried first.
  `plainToInstance` recurses over the whole plain object to build the DTO, and
  the global `ValidationPipe` runs that **before** any `@Validate` constraint,
  so a guard on the field never gets a turn. The spec pins this: driving the
  real `CreatePostDto` with a deep body throws `RangeError` from
  `plainToInstance` itself.

### The fix

`bodyShapeMiddleware()`, registered after the parsers and **before** the global
pipe, answers 413 for a body past `MAX_JSON_DEPTH` (12) or `MAX_JSON_NODES`
(5,000).

`jsonShape` is **iterative on purpose**: a recursive depth check would overflow
on exactly the input it exists to reject. It also stops at the ceiling rather
than walking the payload — a 20,000-deep body is refused after 14 nodes, in
about a millisecond, so a hostile request costs only what the ceiling allows.

The field-level `BoundedJsonConstraint` is kept for the shapes that do reach
validation, but the middleware is what stops the crash.

## The body size limit

Nothing in `main.ts` set a limit, so the JSON parser ran with body-parser's
100kb default — **a ceiling in front of every route that nobody chose**, and one
that moves on a dependency bump.

### Why `useBodyParser` and not `app.use(express.json(...))`

A probe settled this, after the first attempt looked right and did nothing:

| Setup                            | 300kb body         |
| -------------------------------- | ------------------ |
| first parser 1mb, second 256kb   | **200** — accepted |
| first parser 100kb, second 256kb | **413**            |

**Only the first parser to read the body counts.** A second `express.json()`
with a smaller limit is dead code. So the limit has to be set on the parser
that actually runs, and `app.useBodyParser('json', { limit })` is the API for
that — it is also the one that **keeps `req.rawBody`**, which matters a great
deal here: both the Stripe and the LemonSqueezy webhooks verify their signature
over `req.rawBody` (`billing.controller.ts`). A parser registered by hand does
not populate it, so signature verification would fail for both providers — a
billing outage, from a change that looks like a size limit.

Nest registers its own parsers inside `app.init()`, which runs on `listen()`,
after `bootstrap()` — and skips a parser already applied. So the calls in
`bootstrap` are the ones that govern.

### Why 256kb

A legitimate post is genuinely large. One post fans out to per-platform
captions, and the platforms' own caps add up — Facebook alone allows 63,206
characters. Summing every platform's cap plus ten media entries each:

```
sum of per-platform caps : 198,198 bytes
mediaItems (10/platform) :  48,000
JSON key overhead        :   1,920
worst-case LEGITIMATE    : 248,118 bytes = 242kb
```

256kb clears that with a little room. A tighter limit would reject posts the
composer invites people to write, and 100kb — today's accidental ceiling —
is **below** it, so a large multi-channel post may already be failing with a
413 nobody chose.

Bulk routes are nowhere near the limit: `ArrayMaxSize(500)` UUIDs is about
19kb.

### The one exception

`POST /media/upload/base64` carries a whole file inline as base64, so a
post-sized ceiling would disable it. It gets 20mb (base64 inflates by about a
third, so roughly a 15MB file), registered **before** the global parsers since
the first parser wins, and setting `rawBody` the same way Nest's does.

No client in any of our repos calls it today — checked across
`socialmedia-frontend`, `auth_for_socialmedia`, `schedura-admin` and
`schedura-landing`, plus server-side callers of `ingestBase64`. The route is
live and reachable, so it gets a limit that fits its job rather than one that
silently breaks it.

Multipart uploads (`upload/file`, 100MB) never reach these parsers — multer
reads those, with its own `limits.fileSize`.

## Caption caps are a backstop, not a platform limit

`CAPTION_MAX` (70,000) and `ALT_TEXT_MAX` (1,000) exist so an unbounded string
cannot reach the database or a platform client. The **real** caps are per
platform and enforced where the post is published
(`composer-validator.service.ts` and each publisher). Repeating one platform's
number in the DTO would contradict that, so `CAPTION_MAX` sits just above the
largest of them (Facebook's 63,206) and leaves the real decision to the code
that knows which platform it is talking to.

## Verified

Measured end-to-end on a real Nest app with the real global `ValidationPipe`
and the real `CreatePostDto`:

| Request                                                    | Result                      |
| ---------------------------------------------------------- | --------------------------- |
| ordinary post                                              | 201                         |
| 200kb body                                                 | 200                         |
| 300kb body                                                 | **413**                     |
| 300kb / 5MB to `upload/base64`                             | 200                         |
| 25MB to `upload/base64`                                    | **413**                     |
| 5,000-deep `metadata`                                      | **413** "nested too deeply" |
| 20,000-deep `metadata`                                     | **413**                     |
| `platformContent: { twitter: { text: 12345, junkField } }` | **400**                     |
| `platformContent: { myspace: … }`                          | **400** unknown key         |
| valid `platformContent`                                    | 201                         |

`req.rawBody` was populated on every path, including the base64 route — so both
webhook providers keep verifying.

Mutation-tested (each fails tests):

| Mutation                                      | Tests that fail                      |
| --------------------------------------------- | ------------------------------------ |
| make `jsonShape` recursive                    | 2 (`RangeError`, the original crash) |
| drop the `platformContent` validator          | 5                                    |
| `EachValueOf` ignores its per-value errors    | 3                                    |
| drop the unknown-key check                    | 1                                    |
| remove the middleware from `main.ts`          | 1                                    |
| move the middleware **after** the global pipe | 1                                    |
| drop `@MaxLength` on `content`                | 1                                    |

The recursive-`jsonShape` mutation is the one worth keeping in mind: it
reproduces the exact stack overflow being fixed, which is why the iterative
walk is load-bearing rather than stylistic.

### A note on the spec's own helper

The first version of the test helper read only top-level `constraints`, so
`mediaItems[0].altText` — nested two levels down — reported `""` and made a
**working** cap look broken. The helper now walks `children`. A test that
cannot see the error it asserts on proves nothing.
