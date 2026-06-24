# Neon → Railway Migration + Industry-Standard Stripe Billing — Design

**Date:** 2026-06-23
**Status:** Approved in principle (pending spec review)
**Repo:** `socialmedia-workspace` (NestJS backend). Frontend is untouched — it talks to the API, not the DB.

## Goal

Move the database from Neon (serverless) to Railway Postgres on a **fresh DB**, and at the same time switch Stripe billing from the current **dynamic create-on-checkout** model to the **industry-standard** model: Stripe Products/Prices are provisioned once (idempotently, by `lookup_key`), the application only **reads** them at runtime, and Stripe is the source of truth for charge amounts.

## Why now

The fresh-DB cutover is the ideal moment: there are **no existing subscribers**, so the one painful part of adopting immutable, pre-provisioned prices (migrating live subscribers off old prices) does not exist. The migration already has to touch the seeding and checkout paths, so doing it the right way now costs little extra and avoids a second billing migration later.

## Decisions (locked with user)

- **Fresh DB + seeds** (no data migration from Neon).
- **Backend runs on Railway**; DB also on Railway → use **internal private networking** at runtime.
- **Driver:** `node-postgres` (`pg` Pool) via `drizzle-orm/node-postgres` (not `postgres-js`).
- **Billing:** industry-standard — Stripe Products/Prices provisioned by **`lookup_key`**, app **read-only**, prices **immutable**.
- **Stripe mode:** **test** keys for this migration (dev DB). Live provisioning happens later via the same script.

---

## Part 1 — Database migration (Neon → Railway)

### 1A. Driver swap

Two runtime files currently use Neon's HTTP driver (`drizzle-orm/neon-http` + `neon()` from `@neondatabase/serverless`):

- `src/drizzle/db.ts` — standalone client (also imported by seeds/scripts), wraps `neonConfig.fetchFunction` with a transient-retry loop.
- `src/drizzle/drizzle.module.ts` — NestJS DI provider (`DRIZZLE`).

Both move to `drizzle-orm/node-postgres` over a shared `pg.Pool`:

- Add deps `pg` + `@types/pg`; remove `@neondatabase/serverless` from runtime imports (may stay in `package.json` until verified, then dropped).
- The entire `neonConfig.fetchFunction` retry block in `db.ts` is **deleted** — a TCP `pg.Pool` reconnects natively; transient single-request retries are no longer the model.
- Pool config: `connectionString` from `DATABASE_URL`, `max` ≈ 10, sane `idleTimeoutMillis` / `connectionTimeoutMillis`, and SSL per §1B. `db.ts` exports `db = drizzle(pool, { schema })`; `drizzle.module.ts` builds the same pool via `ConfigService`.
- `src/drizzle/db-utils.ts` and `drizzle.config.ts` need no driver change (drizzle-kit uses its own `pg` under the `postgresql` dialect).

### 1B. Connection / SSL strategy

Two connection contexts, and we keep both on the **private network** wherever possible so we never disable TLS verification:

| Context | `DATABASE_URL` | SSL |
|---|---|---|
| Railway runtime (app on Railway) | `${{Postgres.DATABASE_URL}}` → `*.railway.internal` | none needed (private network) |
| **Admin tasks** (migrate / seed / provision) — **preferred** | run them **on Railway** against the **internal** DB (a one-off service command / Railway shell / deploy command), so they use `*.railway.internal` too | none needed (private network) |
| Admin tasks from a local machine — fallback only | Railway **public** URL `*.proxy.rlwy.net` | **TLS verified** — `sslmode=verify-full` + Railway CA (`ssl: { ca }`) |

Rationale: a local machine cannot reach `*.railway.internal`, which is exactly why the **preferred** path runs migrations/seed/provision *inside* Railway (one-off command on the backend service) — that keeps them on the private network, with no public exposure and no TLS-verification question at all.

**Security — do NOT disable TLS verification.** If a public-proxy connection from a local machine is unavoidable, verify the certificate properly: `sslmode=verify-full` with Railway's CA passed as `ssl: { ca: <pem> }`. `rejectUnauthorized: false` (which permits MITM) is **not** part of this design; if ever used it must be an explicit, acknowledged, dev-only last resort, never the committed default.

**Pool SSL config (one helper):** for the internal host → `ssl: false`. For an external host → `ssl` configured with the verified CA (never `rejectUnauthorized: false`). Driven off the connection-string host; no separate env flag.

### 1C. Schema + base seed

1. `npm run db:migrate` (drizzle-kit, against the public URL) → all tables created from `drizzle/migrations`.
2. `ts-node src/drizzle/seeds/plans.seed.ts` → seeds `plans` + `addonPricing` (Stripe IDs still empty at this stage; filled by Part 2).
3. No other seeds exist. Fresh DB ⇒ no users — users re-sign-up; super-admin is granted by email match (`NEXT_PUBLIC_SUPER_ADMIN_EMAIL` / backend equivalent) on signup, so no user seed is needed.

---

## Part 2 — Industry-standard Stripe billing

### 2A. Model

- Each **paid** plan (PRO, MAX) = one Stripe **Product** + one recurring **Price**, identified by a deterministic `lookup_key`. FREE (`basePriceCents = 0`) gets **no** Stripe price (no charge).
- Each **addon** row = its own recurring Price with its own `lookup_key`.
- The DB `stripePriceId` columns (`plans.stripePriceId`, `addonPricing.stripePriceId`) hold the resolved price id as a fast runtime cache. **Stripe is the source of truth for the charge amount**; `basePriceCents` / `pricePerUnitCents` are for display + plan limits and must be kept in sync with the Stripe price (see runbook).

**`lookup_key` scheme** (stable, human-readable):

| Entity | lookup_key |
|---|---|
| PRO plan (monthly) | `plan_pro_monthly` |
| MAX plan (monthly) | `plan_max_monthly` |
| Addon (per type, per plan) | `addon_<type>_<plan>` — e.g. `addon_extra_channel_pro`, `addon_ai_tokens_max` |

Addon types from the seed: `extra_channel`, `extra_member`, `extra_workspace`, `ai_tokens` × `pro` / `max` = 8 prices.

### 2B. Provision script (new) — `src/drizzle/seeds/stripe-provision.ts`

A standalone, idempotent, **sequential** script (run once after the base seed, locally against the public DB URL + test Stripe key). For each paid plan and each addon row:

1. Resolve the Price by `lookup_key`:
   `stripe.prices.list({ lookup_keys: [key], active: true, expand: ['data.product'] })` — this is a **consistent** lookup (unlike `products.search`, which is the eventually-consistent call behind the old dup hazard).
2. If a price exists with the **same amount/interval** → reuse its id.
3. If none exists → create the Product (if needed) then the Price **with `lookup_key`** set, `unit_amount` from the DB cents, `currency: 'usd'`, `recurring: { interval: 'month' }`, `metadata: { planCode | addonType }`.
4. If a price exists with a **different amount** (reprice path) → create a new Price with the new amount, `transfer_lookup_key=true` onto it, deactivate the old Price, use the new id.
5. Write the resolved price id back to `plans.stripePriceId` / `addonPricing.stripePriceId`.

The script is **re-runnable** (idempotent: step 2 short-circuits) and **never runs concurrently**, so there is no `products.search` lag and no duplicate products. It prints the **Stripe account/mode** (test vs live) and every created/reused id up front as a guard.

The existing `getOrCreatePriceForPlan` / `getOrCreatePriceForAddon` in `src/stripe/stripe.service.ts` are refactored to this `lookup_key`-based, provisioning-only form (renamed e.g. `ensurePriceForPlan` / `ensurePriceForAddon`) and are called **only** by this script.

### 2C. Checkout becomes read-only

Three services currently do `if (!stripePriceId) { getOrCreate…; save back }` at runtime:

- `src/billing/services/subscription.service.ts` (~L122–136)
- `src/billing/services/plan-change.service.ts` (~L283–297)
- `src/billing/services/addon.service.ts` (~L169–185)

Each is changed to **read the stored `stripePriceId`** and, if it is missing/empty, **throw a clear error** (`BadRequestException('Plan/addon "<code>" is not provisioned in Stripe — run the pricing provision script')`) instead of creating at runtime. This permanently removes the concurrency/search-lag duplicate path. No runtime Stripe **writes** for pricing remain.

**FREE plan is exempt:** `FREE` (`basePriceCents = 0`) has no Stripe price and creates no Stripe subscription — the read-only guard applies only to the paid path. The implementer must ensure subscribing to FREE does not reach the "missing price → throw" branch (it should short-circuit before any Stripe price lookup).

---

## Part 3 — Cutover, verify, rollback

1. Run order (enforced): driver swap merged → run the admin tasks against the Railway DB (preferably a one-off command **on the Railway service**, internal network — see §1B) → `db:migrate` → `plans.seed` → `stripe-provision` (test) → verify DB has all `stripePriceId` populated for paid plans + addons.
2. Set Railway backend `DATABASE_URL` → internal Postgres; remove the Neon var and `@neondatabase/serverless` dep.
3. `npm run build` green; smoke test: login (`/auth/me` → DB), a billing checkout (reads provisioned price, **no** Stripe create), a channel/post read, a plan change, an addon purchase.
4. Keep Neon read-only for a short rollback window, then decommission.

---

## Part 4 — Price-change runbook (→ add to `docs/super-admin-api.md`)

**Deliverable:** add the following as a new "Pricing & Stripe Operations" section in `docs/super-admin-api.md` (the super-admin documentation) when Part 2 lands.

> **How to change a plan or addon price** (Stripe prices are immutable):
>
> 1. **Never** edit an existing Stripe price's amount, and **never** create prices at runtime — only via the provision script.
> 2. To change a price (e.g. PRO $10 → $12):
>    a. Update the amount in the DB (`plans.basePriceCents` or `addonPricing.pricePerUnitCents`).
>    b. Run the provision script (reprice path): it creates a **new** Stripe Price with the new amount, runs `transfer_lookup_key=true` to move the stable key (e.g. `plan_pro_monthly`) onto the new price, **deactivates** the old price, and updates the DB `stripePriceId` to the new id.
>    c. **Existing subscribers keep their old price** (their Stripe subscription still references the old price id) until explicitly migrated; **new** checkouts use the new price automatically.
>    d. (Optional) Migrate existing subscribers to the new price via a Stripe subscription update with your chosen proration behavior.
> 3. Do this in **both** test and live modes (run the script with each mode's key).
> 4. Display amounts (`basePriceCents` / `pricePerUnitCents`) are a mirror — after any change, the DB and the Stripe price must agree; the provision script keeps them in sync.

---

## Out of scope (YAGNI)

- Data migration from Neon (fresh DB chosen).
- Connection pooling beyond a single `pg.Pool` (no PgBouncer), multi-region, read replicas.
- Annual/yearly prices, coupons, tax, Stripe Entitlements API, usage-based billing.
- Frontend changes (none — it consumes the API).
- CI/CD changes.

## Risks

- **Run-order dependency:** `stripe-provision` MUST run before any checkout, else read-only checkout throws. The cutover checklist (Part 3) enforces order.
- **Internal URL is unreachable from a laptop** — that's why admin tasks (migrate/seed/provision) preferentially run *on* Railway (internal network); if run from local over the public proxy, TLS must be **verified** (never `rejectUnauthorized: false`). Documented in §1B so it isn't a confusing connection failure or a silent security downgrade.
- **Wrong Stripe key (test vs live):** the provision script echoes the account/mode before doing anything as a guard.
- **DB ↔ Stripe amount drift:** editing `basePriceCents` without running the reprice path leaves display and charge out of sync; the runbook makes the correct procedure explicit.

## Decomposition (for the plan stage)

This spec yields **two independently testable implementation plans**, executed in sequence:

1. **DB migration plan** — driver swap (`pg` Pool), SSL/env, schema migrate, base seed, build/smoke verify. Independently shippable.
2. **Stripe billing plan** — `lookup_key` provision script, `stripe.service` refactor, read-only checkout in the 3 services, and the super-admin runbook doc.

## Testing / verification approach

No automated test runner is exercised for this infra change; verification is: backend `npm run build` green; `npm run lint`; and the manual smoke tests in Part 3 run against the Railway DB with test Stripe keys. Each plan's tasks end with build + the relevant smoke check.
