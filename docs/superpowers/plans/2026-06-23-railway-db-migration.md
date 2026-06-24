# Railway DB Migration (Neon → Railway Postgres) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap the backend's database driver from Neon's HTTP serverless driver to standard `node-postgres` (TCP) so the app runs against Railway Postgres, with secure TLS handling.

**Architecture:** A shared `buildPoolConfig` helper produces a `pg.Pool` config from `DATABASE_URL` (TLS off on Railway's private network, verified TLS on the public proxy — never disabled). The two existing Drizzle clients (`db.ts`, `drizzle.module.ts`) move from `drizzle-orm/neon-http` to `drizzle-orm/node-postgres` over that pool. Schema migrate / seed / cutover are operational steps in a runbook (run against the live Railway DB), not code tasks.

**Tech Stack:** NestJS, Drizzle ORM 0.45, `pg` (node-postgres) 8, Jest, TypeScript.

## Global Constraints

- This is the **`socialmedia-workspace`** backend repo, branch `feat/railway-migration-stripe-billing`. The frontend is untouched.
- **Driver:** `node-postgres` via `drizzle-orm/node-postgres` (NOT `postgres-js`, NOT `neon-http`).
- **Security — never disable TLS verification.** Do NOT use `ssl: { rejectUnauthorized: false }` anywhere. Internal Railway host → `ssl: false`; public/proxy host → verified TLS (`rejectUnauthorized: true`, optional `DATABASE_CA_CERT`).
- **Verification:** backend has Jest (`npm run test`) + `npm run build` (`nest build`) + `npm run lint`. Pure logic (the SSL helper) gets a real unit test; the driver wiring is verified by `build` + `lint` (a live-DB connection is a runbook smoke test, not a unit test). Do not add a DB connection to any unit test.
- **Git safety:** `.env` is NOT tracked in this repo, but never `git add .` and never stage `.env`/`.env.backup`. Stage only the exact files per task.
- **No data migration** (fresh DB) — out of scope here.

## File Structure

- **New:** `src/drizzle/pool-config.ts` — `buildPoolConfig(connectionString): PoolConfig`. Single source of pool + TLS policy.
- **New:** `src/drizzle/pool-config.spec.ts` — Jest unit tests for the TLS decision.
- **Modify:** `src/drizzle/db.ts` — standalone client → node-postgres + `buildPoolConfig`.
- **Modify:** `src/drizzle/drizzle.module.ts` — NestJS provider → node-postgres + `buildPoolConfig`.
- **Modify:** `package.json` — add `pg` + `@types/pg`; remove `@neondatabase/serverless`.
- **Unchanged:** `drizzle.config.ts`, `src/drizzle/db-utils.ts` (drizzle-kit uses its own pg for the `postgresql` dialect).

---

## Task 1: Pool config helper + TLS unit tests + deps

**Files:**
- Create: `src/drizzle/pool-config.ts`
- Create: `src/drizzle/pool-config.spec.ts`
- Modify: `package.json` (add `pg`, `@types/pg`)

**Interfaces:**
- Produces: `buildPoolConfig(connectionString: string): import('pg').PoolConfig` — used by Tasks 2 and 3.

- [ ] **Step 1: Add the `pg` dependency**

Run: `npm install pg@^8 @types/pg@^8`
Expected: `package.json` gains `pg` (dependencies) and `@types/pg` (devDependencies); install succeeds.

- [ ] **Step 2: Write the failing unit test**

Create `src/drizzle/pool-config.spec.ts`:

```ts
import { buildPoolConfig } from './pool-config';

describe('buildPoolConfig', () => {
  const INTERNAL = 'postgresql://u:p@postgres.railway.internal:5432/railway';
  const PUBLIC = 'postgresql://u:p@abc.proxy.rlwy.net:12345/railway';
  const SSLMODE = 'postgresql://u:p@somehost:5432/db?sslmode=require';
  const LOCAL = 'postgresql://u:p@localhost:5432/db';

  afterEach(() => {
    delete process.env.DATABASE_CA_CERT;
  });

  it('disables TLS for the Railway internal (private network) host', () => {
    expect(buildPoolConfig(INTERNAL).ssl).toBe(false);
  });

  it('disables TLS for a plain localhost connection', () => {
    expect(buildPoolConfig(LOCAL).ssl).toBe(false);
  });

  it('enables verified TLS for the Railway public proxy host', () => {
    expect(buildPoolConfig(PUBLIC).ssl).toEqual({ rejectUnauthorized: true });
  });

  it('enables verified TLS when the URL carries sslmode=require', () => {
    expect(buildPoolConfig(SSLMODE).ssl).toEqual({ rejectUnauthorized: true });
  });

  it('includes the CA when DATABASE_CA_CERT is set (still verified)', () => {
    process.env.DATABASE_CA_CERT = 'CERT-PEM';
    expect(buildPoolConfig(PUBLIC).ssl).toEqual({
      ca: 'CERT-PEM',
      rejectUnauthorized: true,
    });
  });

  it('never disables certificate verification', () => {
    const ssl = buildPoolConfig(PUBLIC).ssl as { rejectUnauthorized?: boolean };
    expect(ssl.rejectUnauthorized).toBe(true);
  });

  it('carries the connection string and a bounded pool size', () => {
    const cfg = buildPoolConfig(PUBLIC);
    expect(cfg.connectionString).toBe(PUBLIC);
    expect(cfg.max).toBe(10);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test -- pool-config`
Expected: FAIL — `Cannot find module './pool-config'` (file not created yet).

- [ ] **Step 4: Implement `pool-config.ts`**

Create `src/drizzle/pool-config.ts`:

```ts
import type { PoolConfig } from 'pg';

/**
 * Build a node-postgres Pool config from a Postgres connection string.
 *
 * Railway runtime connects over the private network (host `*.railway.internal`)
 * with no TLS. Admin tasks from a local machine connect over the public proxy
 * (host `*.rlwy.net` / `*.railway.app`, or the URL carries `sslmode=`) and MUST
 * use VERIFIED TLS. We never set `rejectUnauthorized: false` (it permits MITM).
 * If Railway's proxy certificate is not in the system trust store, supply its CA
 * via the `DATABASE_CA_CERT` env var.
 */
export function buildPoolConfig(connectionString: string): PoolConfig {
  const needsSsl =
    /sslmode=(require|verify-ca|verify-full)/.test(connectionString) ||
    /\.rlwy\.net|\.railway\.app/.test(connectionString);

  const ca = process.env.DATABASE_CA_CERT;

  return {
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: needsSsl
      ? ca
        ? { ca, rejectUnauthorized: true }
        : { rejectUnauthorized: true }
      : false,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -- pool-config`
Expected: PASS — all 7 tests green.

- [ ] **Step 6: Lint**

Run: `npx eslint "src/drizzle/pool-config.ts" "src/drizzle/pool-config.spec.ts"`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/drizzle/pool-config.ts src/drizzle/pool-config.spec.ts package.json package-lock.json
git commit -m "feat(db): add node-postgres pool-config helper with verified TLS"
```

---

## Task 2: Swap `db.ts` to node-postgres

**Files:**
- Modify: `src/drizzle/db.ts` (full rewrite below)

**Interfaces:**
- Consumes: `buildPoolConfig` (Task 1).
- Produces: `export const db` (Drizzle node-postgres client) + `export type DbType` — unchanged names, so every existing importer (seeds, services that import from `../db`) keeps working.

- [ ] **Step 1: Rewrite `src/drizzle/db.ts`**

Replace the entire file with:

```ts
import { config } from 'dotenv';
config();

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { buildPoolConfig } from './pool-config';

/**
 * Shared Postgres connection pool (node-postgres / TCP).
 *
 * Migrated off Neon's HTTP serverless driver: Railway is standard TCP Postgres,
 * so a long-lived pool replaces the per-request HTTP fetch (and its transient-
 * retry wrapper — the pool reconnects natively). TLS policy lives in
 * `buildPoolConfig`: off on Railway's private network, verified on the public
 * proxy.
 */
const pool = new Pool(buildPoolConfig(process.env.DATABASE_URL!));

export const db = drizzle(pool, { schema });

export type DbType = typeof db;
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: `nest build` succeeds, no TypeScript errors. (The old `neonConfig`/retry code is gone; nothing else should reference it — confirmed only `db.ts` and `drizzle.module.ts` used Neon.)

- [ ] **Step 3: Lint**

Run: `npx eslint "src/drizzle/db.ts"`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/drizzle/db.ts
git commit -m "refactor(db): db.ts to node-postgres pool"
```

---

## Task 3: Swap `drizzle.module.ts` to node-postgres

**Files:**
- Modify: `src/drizzle/drizzle.module.ts` (full rewrite below)

**Interfaces:**
- Consumes: `buildPoolConfig` (Task 1).
- Produces: the `DRIZZLE` provider (unchanged token + export), now backed by a node-postgres pool.

- [ ] **Step 1: Rewrite `src/drizzle/drizzle.module.ts`**

Replace the entire file with:

```ts
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { buildPoolConfig } from './pool-config';

export const DRIZZLE = 'DRIZZLE';

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const databaseUrl = configService.get<string>('DATABASE_URL');

        if (!databaseUrl) {
          throw new Error('DATABASE_URL is not defined');
        }

        const pool = new Pool(buildPoolConfig(databaseUrl));
        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DrizzleModule {}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: `nest build` succeeds, no TypeScript errors. (The `useFactory` is now synchronous — no `await` remains; that is correct.)

- [ ] **Step 3: Lint**

Run: `npx eslint "src/drizzle/drizzle.module.ts"`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/drizzle/drizzle.module.ts
git commit -m "refactor(db): DRIZZLE provider to node-postgres pool"
```

---

## Task 4: Remove the Neon dependency + final verify

**Files:**
- Modify: `package.json` (remove `@neondatabase/serverless`)

**Interfaces:** none.

- [ ] **Step 1: Confirm nothing imports the Neon driver anymore**

Run: `npx rg "neon-http|@neondatabase/serverless|neonConfig|drizzle-orm/neon" src`
Expected: **no matches** (Tasks 2 and 3 removed the only two usages). If anything matches, STOP and fix that file before removing the dep.

- [ ] **Step 2: Remove the dependency**

Run: `npm uninstall @neondatabase/serverless`
Expected: `@neondatabase/serverless` gone from `package.json` dependencies.

- [ ] **Step 3: Full build**

Run: `npm run build`
Expected: `nest build` succeeds, no errors.

- [ ] **Step 4: Full test + lint**

Run: `npm run test -- pool-config` then `npm run lint`
Expected: pool-config tests pass; lint passes (or only pre-existing warnings unrelated to these files).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(db): drop @neondatabase/serverless"
```

---

## Operational runbook (run by a human against the live Railway DB — NOT subagent tasks)

These steps connect to the real Railway database and Stripe-free; they are not part of the automated task loop. Run them after Tasks 1–4 are merged.

1. **Provision check:** Railway Postgres exists; the backend service is in the same Railway project.
2. **Run schema migration on the private network (preferred):** from a one-off command on the Railway backend service (so it uses the internal `DATABASE_URL`, no TLS): `npm run db:migrate`.
   - *Local fallback:* set local `DATABASE_URL` to the Railway **public** URL; if the connection fails on TLS, download Railway's CA and set `DATABASE_CA_CERT` to its PEM contents, then re-run. Do **not** disable verification.
3. **Seed base data:** `ts-node src/drizzle/seeds/plans.seed.ts` (same connection rules as step 2). Confirm `plans` + `addon_pricing` rows exist.
4. **Cutover:** set the Railway backend `DATABASE_URL` → internal Postgres (`${{Postgres.DATABASE_URL}}`). Deploy.
5. **Smoke test:** log in (`/auth/me` → DB read succeeds), open a workspace, read posts/channels. No Neon traffic.
6. **Rollback window:** keep Neon reachable (read-only) for a short window; once stable, decommission Neon and remove its env var.

> Stripe products/prices are handled by the **separate Stripe billing plan** (`2026-06-23-stripe-lookup-key-billing.md`), which runs after this migration. Until that lands, billing still uses the old create-on-checkout path.

---

## Self-review notes

- **Spec coverage:** Part 1 (driver swap §1A, SSL §1B, schema/seed §1C) → Tasks 1–4 + runbook. Part 3 cutover/rollback → runbook. Stripe (Part 2/4) is explicitly the next plan.
- **Security:** `buildPoolConfig` never emits `rejectUnauthorized: false`; a dedicated test asserts verification stays on.
- **Type consistency:** `buildPoolConfig` signature identical across Tasks 1–3; `db` / `DbType` / `DRIZZLE` export names unchanged so importers don't break.
