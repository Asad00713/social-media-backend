# Throttling the auth routes

Phase 3 audit item #4, part one. The audit counted "250+ unthrottled routes";
the real figure is **774 routes across 81 controllers**. Neither number is the
useful one, because counting routes measures the wrong thing: what matters is
how many routes a stranger can reach and spend our resources on, and how many
of those are not bounded by anything.

Measured, that list is short.

## What was already bounded

Most of the surface the audit flagged was already protected — by something
other than a throttle, which is why a route count missed it:

| Surface                        | Bound                                                       |
| ------------------------------ | ----------------------------------------------------------- |
| 65 of 81 controllers           | a JWT guard                                                 |
| 38 AI / LLM endpoints          | the workspace AI token balance (`executeWithTokens` throws) |
| library ZIP download (2 GB)    | a signed, workspace-bound, 5-minute ticket                  |
| TikTok media proxy             | a signed JWT, 1-hour TTL                                    |
| public reports, email, contact | `@Throttle` + a custom per-caller guard                     |

The AI one is worth stating plainly, because it inverts the obvious reading:
38 endpoints that run a model carry no `@Throttle` at all, and they do not need
one for **cost**. Spend is capped by the plan's token balance, not by request
rate — an attacker with a valid JWT cannot run up a bill, they can only exhaust
the balance their own workspace paid for.

## The trap this had to avoid

The default tracker on `ThrottlerGuard` is `req.ip`. The app deliberately does
not set `trust proxy`, and in production it runs behind Railway's edge, so
`req.ip` is **the edge address for every visitor**. A throttle on that tracker
puts all customers in one bucket: the first caller to exhaust the limit 429s
everybody else. That is strictly worse than no limit at all.

`ClientIpThrottlerGuard` (now in `common/guards/`) already solved this. It
tracks, in order:

1. `X-Real-IP` — Railway's edge sets it to the client's remote address on every
   request;
2. the **rightmost** `X-Forwarded-For` entry — the edge appends what it saw, so
   only the last hop is not caller-controlled;
3. `req.ip`.

The rightmost entry, not the leftmost: the leftmost is whatever the caller sent
and can be rotated to dodge the limit. The guard moved out of
`channels/connect-links/` because two unrelated surfaces now need it.

## Why only four routes

`auth.controller.ts` has 13 routes and had 2 throttled — and the 2 were the
super-admin sign-in pair, not the customer-facing ones. But adding a throttle to
the other 11 would have been wrong: most are bounded already, and a limit that
protects nothing still has to be maintained and still fires on real users.
Checked one at a time:

| Route                                   | Bounded by                                                            | Needs a throttle? |
| --------------------------------------- | --------------------------------------------------------------------- | ----------------- |
| `verify-otp`                            | `MAX_CODE_ATTEMPTS` = 5, **claimed atomically before** the comparison | no                |
| `reset-password`                        | a `crypto.randomBytes(32)` token — 256 bits                           | no                |
| `verify-email`                          | the same token shape                                                  | no                |
| `refresh`                               | `JwtRefreshGuard`                                                     | no                |
| `logout` / `me` / `onboarding/complete` | `JwtAuthGuard`                                                        | no                |
| `admin/challenge` / `admin/verify`      | their own `@Throttle` + a per-address cooldown                        | already           |
| **`login`**                             | **nothing**                                                           | **yes**           |
| **`register`**                          | a duplicate-address check only                                        | **yes**           |
| **`forgot-password`**                   | a 5-minute cooldown **per account**                                   | **yes**           |
| **`resend-verification`**               | a 60-second cooldown **per account**                                  | **yes**           |

`verify-otp` deserves a note: the attempt is claimed _before_ the code is
compared, so a parallel burst of a thousand requests still only tests five
codes. A throttle on top of that would add nothing. This is the same judgement
BE #247 got wrong in the other direction, where a guard was written for a state
that could not occur.

### The two cooldowns cap repeats, not fan-out

`forgot-password` and `resend-verification` _do_ refuse a second mail to the
same address. That is a different question from the one a throttle answers: the
cooldown is keyed on the **account**, so a caller hitting a thousand different
addresses gets a thousand first emails, each one free. Our Resend quota and our
sender reputation both pay for that.

So the new limits sit **on top of** the cooldowns, not in place of them. Repeats
to one address stay the service's job; fan-out from one caller is the throttle's.

### `login` is the only genuinely open one

No attempt counter, no lockout, no throttle. And `bcrypt` at cost 10 spends real
CPU per guess, so an unbounded `login` is two problems in one: credential
stuffing, and a cheap way to saturate the web process.

## The limits

In `auth/auth-throttle.ts`, named rather than inline, so the number and the
reasoning for it cannot drift apart.

| Route                 | Limit       | Why that number                                                                                                                   |
| --------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `login`               | 10 / 15 min | the ceiling `admin/verify` was already tuned to. Ten mistypes in a quarter-hour means using the reset link, not an eleventh guess |
| `register`            | 5 / hour    | a person signs up once; 5 covers a typo, a mid-signup abandon, and a few colleagues behind one office NAT                         |
| `forgot-password`     | 5 / hour    | a fan-out cap. One person recovering one account needs 1–2                                                                        |
| `resend-verification` | 15 / 15 min | looser on purpose — see below                                                                                                     |

### Why resend is looser than reset

These two started as one limit of 5 an hour, which was wrong, and the frontend
is what showed it. Resend is the only button a half-finished signup has, and the
real path through that screen is not one press: the first code lands in spam, so
they press it; still nothing, so they press again; then they spot the typo in
their address, take "Use a different email", sign up again, and need codes for
the new address too. Five an hour runs out partway through — and the screen it
runs out on has nowhere else to go, so the person is locked out of their own
signup for the rest of the hour.

Worse, the UI would have shown it: `check-email-card.tsx` restarts its countdown
from the 429's `retryAfterSeconds`, so a one-hour limit renders a literal
`60:00` ticking down with the resend button disabled behind it.

Fifteen in fifteen minutes is the shape `admin/challenge` arrived at after
exactly this failure. The shorter window matters more than the bigger number:
whatever the person does wrong, they are never more than fifteen minutes from
trying again. It is still a real cap on mail — the 60-second per-account
cooldown means one address cannot take more than 15 of these anyway, fan-out
from one caller is bounded at 60 an hour, and the endpoint only ever mails an
address that already has an unverified account waiting on it.

None of these is near a real user's behaviour, which is the point: a throttle
tuned against an imagined attacker rather than a real session locks out the
owner. That already happened here once — the `admin/challenge` comment records
a limit of 5 that a couple of fumbled sign-ins burned through, leaving a 429
the UI could only describe as "could not reach the server".

## Tests

`auth-throttle.spec.ts` (30). The limit and guard assertions are ordinary, but
the suite's real work is a **fail-closed net**: it derives the route list from
the controller's own `PATH_METADATA` and requires every handler to be bounded by
a throttle, a JWT guard, or a named entry in `BOUNDED_IN_CODE` that says which
mechanism bounds it. A route added later with none of the three fails the suite
without anyone remembering to update a list — the gap BE #251 and BE #252 both
had was a missing line, not a wrong one.

The metadata keys were measured rather than assumed: `@Throttle` appends the
config name with **no separator** (`THROTTLER:LIMITdefault`).

Mutation-tested:

| Mutation                                                 | Tests that fail |
| -------------------------------------------------------- | --------------- |
| remove the `login` throttle                              | 3               |
| swap `ClientIpThrottlerGuard` → plain `ThrottlerGuard`   | 2               |
| loosen `login` from 10 to 1000                           | 1               |
| **add a new unbounded public route**                     | **1**           |
| remove the human 429 body (back to `ThrottlerException`) | 10              |
| drop the 1-second floor on the wait                      | 2               |
| make resend as strict as reset (5/hour)                  | 3               |
| loosen resend to 150 / 15 min                            | 2               |

The unbounded-route one is what the net exists for.

## The 429 had to be worth showing

`@nestjs/throttler` throws with the literal message
`"ThrottlerException: Too Many Requests"`, and `lib/api.ts` on the frontend puts
a failed request's `message` straight into a toast. So a limited sign-in would
have told the person, verbatim:

> ThrottlerException: Too Many Requests

That is the same failure the `admin/challenge` comment already records in
another form — a 429 the UI could only describe as "could not reach the server".
Shipping the limits without this would have reintroduced it.

`ClientIpThrottlerGuard` therefore overrides `throwThrottlingException` (not
just `getErrorMessage`, which would fix the sentence and still leave a body with
no machine-readable tag) and answers:

```json
{
  "statusCode": 429,
  "error": "Too Many Requests",
  "code": "RATE_LIMITED",
  "message": "Too many attempts. Try again in 3 minutes.",
  "retryAfterSeconds": 180
}
```

`retryAfterSeconds` is deliberately that name: the frontend's
`resendCooldownFrom` already reads exactly this field off a 429 to drive its
countdown, so the existing code picks it up with no change. The value is
`timeToBlockExpire`, the same number the guard puts in `Retry-After`, floored at
1 — a sub-second remainder would otherwise read "try again in 0s" and send the
person straight into another 429.

### A test that was green and testing nothing

The first version of the guard spec caught the exception with a synchronous
`try/catch`. The base `throwThrottlingException` is `async`, so its throw is a
**rejected promise** a sync catch cannot see — which meant the tests only ever
exercised the override (which throws synchronously), and deleting the override
crashed the Jest worker with an unhandled rejection instead of failing a test.
Awaiting the call fixed it: that mutation now fails **10** tests.

## Deliberately not done

- **No global `ThrottlerGuard`.** `app.module.ts` registers `ThrottlerModule`
  with no app guard on purpose, and the comment there explains why: a platform
  that has never had rate limiting has not been measured for one, and a global
  limit tuned wrong rejects real traffic everywhere at once. Opt-in per route
  stays the rule until there is data.
- **No throttle on the 38 AI endpoints.** Their cost is already bounded by the
  token balance; a rate limit would only change _how fast_ a workspace spends
  what it has already paid for.

## Known inconsistency, not fixed here

The repo has **two** per-caller throttler guards that answer the proxy question
differently:

| Guard                         | Tracker                                    |
| ----------------------------- | ------------------------------------------ |
| `ClientIpThrottlerGuard`      | `X-Real-IP` → **rightmost** XFF → `req.ip` |
| `ReportsPublicThrottlerGuard` | **leftmost** XFF → `req.ip`                |

The second is used by the public reports, email and contact controllers, and its
own comment concedes the consequence: _"a caller can pick its own bucket… This
is a soft limit, and the ruling accepts that."_ The first cites Railway's own
guidance that `X-Real-IP` is set by the edge and can be trusted.

Both cannot be right. Reconciling them is a change to routes this work does not
touch, so it is recorded here rather than bundled in.
