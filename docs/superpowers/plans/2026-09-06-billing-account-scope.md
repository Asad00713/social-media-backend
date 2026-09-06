# Billing Account Scope + Pricing Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move subscriptions from workspace-scoped to user-scoped, and add per-workspace queued-post limits plus an `EXTRA_WORKSPACE` add-on that grants an empty workspace.

**Architecture:** One user owns one subscription. `workspace_usage` stays per-workspace and keeps its shape — only the *source* of its numbers changes, from the workspace's own subscription to the owner's single subscription. Because one subscription now covers many workspaces, every write that used to target one usage row must fan out to all of the owner's workspaces. Two pure functions (`resolveWorkspaceLimits`, `canQueuePost`) carry the testable logic.

**Tech Stack:** NestJS, Drizzle ORM, PostgreSQL, Jest (ts-jest), React 19 + Vite 8 + TanStack Query (frontend).

**Spec:** `docs/superpowers/specs/2026-09-06-billing-account-scope-design.md`

## Global Constraints

- **Backend repo:** `socialmedia-workspace`, branch `feat/billing-account-scope` (already created off `origin/main`). **Frontend repo:** `socialmedia-frontend` — branch `feat/billing-account-scope` must be created off `origin/main`, NOT off the current `feat/layout-redesign-proto`, which holds unrelated uncommitted work.
- **Migrations are hand-written.** `npm run db:generate` and `npm run db:migrate` are unusable in this repo (migration journal drift — drizzle-kit emits a spurious 15-table diff). Write the `.sql` file by hand. The next number is **`0030`**. Do not run `db:generate`.
- **`-1` means unlimited** for `queued_posts_per_channel`. Never treat it as a literal count.
- **`posts.targets[].channelId` is a STRING**, written as `String(channel.id)` (`post.service.ts:144`) even though `social_media_channels.id` is a bigint. Every jsonb containment query MUST stringify the channel id or it will silently match nothing.
- **Test command:** `npm test -- <path>` from `socialmedia-workspace/`. Jest `rootDir` is `src`, `testRegex` is `.*\.spec\.ts$`. Specs are co-located with source.
- **Prettier:** single quotes, trailing commas.
- **NEVER run `npm run lint`.** That script is `eslint "{src,apps,libs,test}/**/*.ts" --fix` — repo-wide, with auto-fix. Running it once during Task 3 modified **132 unrelated files**, and not merely cosmetically: ignoring whitespace entirely, 2843 lines still differed, because eslint stripped non-null assertions and type casts (`r.workspace!` becomes `r.workspace`, and a dropped `as 'ADMIN' | 'MEMBER' | 'GUEST'`) in files including `auth.service.ts`, the login path. That sweep is parked on branch `chore/eslint-fix-sweep`. **Lint only the files you touched**, naming each one:
  ```bash
  npx eslint path/to/file-you-changed.ts path/to/other-file.ts
  ```
  Never pass a glob, and never add `--fix` to a path you did not write yourself.
- **`gh` CLI needs an explicit account switch per repo:** `gh auth switch --user Asad00713` for backend, `--user asad00712` for frontend. Binary is off-PATH at `/c/Program Files/GitHub CLI/gh.exe`.
- **Plan tier values are authoritative from this plan**, not from the existing seed. Note MAX channels changes from the seed's `50` to `25`.

---

## File Structure

**Backend — create:**

| File | Responsibility |
|---|---|
| `src/billing/services/limit-resolver.util.ts` | Pure limit math: `resolveWorkspaceLimits`, `canQueuePost` |
| `src/billing/services/limit-resolver.util.spec.ts` | Tests for the above |
| `src/billing/services/subscription-lookup.service.ts` | The one place a subscription is found for a user or a workspace's owner |
| `src/billing/services/usage-fanout.util.ts` | Pure: given owner's workspaces + plan + add-ons, produce the per-workspace limit rows to write |
| `src/billing/services/usage-fanout.util.spec.ts` | Tests for fan-out, incl. the EXTRA_WORKSPACE-grants-zero-channels rule |
| `src/billing/services/post-queue.service.ts` | Queued-post counting + enforcement |
| `src/billing/services/post-queue.service.spec.ts` | Tests for the queue query shape |
| `drizzle/migrations/0030_billing_account_scope.sql` | Hand-written migration |

**Backend — modify:** `billing.schema.ts`, `usage.service.ts`, `subscription.service.ts`, `subscription-sync.util.ts`, `webhook.service.ts`, `addon.service.ts`, `plan-change.service.ts`, `invoice.service.ts`, `dashboard.service.ts`, `admin.service.ts`, `ai-token.service.ts`, `chatbot.service.ts`, `workspace-suspended.guard.ts`, `workspace.service.ts`, `post.service.ts`, `composer-scheduling.service.ts`, `plans.seed.ts`, `billing.controller.ts`.

**Frontend — modify:** `billing.api.ts`, `types/billing.ts`, the plan/usage/addon components, and the hooks that key on `workspaceId`.

---

## Task 1: Pure limit-resolution functions

No DB, no NestJS. This is the logic the rest of the plan leans on, so it lands first and alone.

**Files:**
- Create: `src/billing/services/limit-resolver.util.ts`
- Test: `src/billing/services/limit-resolver.util.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface PlanLimits {
    channelsPerWorkspace: number;
    membersPerWorkspace: number;
    maxWorkspaces: number;
    aiTokensPerMonth: number;
    queuedPostsPerChannel: number;   // -1 = unlimited
  }
  export interface AddonQuantities {
    extraChannels: number;
    extraMembers: number;
    extraWorkspaces: number;
    extraAiTokens: number;           // already multiplied by unitsPerQuantity
  }
  export interface ResolvedWorkspaceLimits {
    channelsLimit: number;
    membersLimit: number;
    aiTokensLimit: number;
    queuedPostsPerChannel: number;
  }
  export function resolveWorkspaceLimits(
    plan: PlanLimits, addons: AddonQuantities, isPrimaryWorkspace: boolean,
  ): ResolvedWorkspaceLimits;
  export function resolveMaxWorkspaces(plan: PlanLimits, addons: AddonQuantities): number;
  export function canQueuePost(queuedPostsPerChannel: number, currentQueued: number): boolean;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/billing/services/limit-resolver.util.spec.ts`:

```ts
import {
  resolveWorkspaceLimits,
  resolveMaxWorkspaces,
  canQueuePost,
  PlanLimits,
  AddonQuantities,
} from './limit-resolver.util';

const PRO: PlanLimits = {
  channelsPerWorkspace: 8,
  membersPerWorkspace: 5,
  maxWorkspaces: 3,
  aiTokensPerMonth: 20000,
  queuedPostsPerChannel: -1,
};

const FREE: PlanLimits = {
  channelsPerWorkspace: 3,
  membersPerWorkspace: 1,
  maxWorkspaces: 1,
  aiTokensPerMonth: 0,
  queuedPostsPerChannel: 10,
};

const NO_ADDONS: AddonQuantities = {
  extraChannels: 0,
  extraMembers: 0,
  extraWorkspaces: 0,
  extraAiTokens: 0,
};

describe('resolveWorkspaceLimits', () => {
  it('returns the plan limits when there are no add-ons', () => {
    expect(resolveWorkspaceLimits(PRO, NO_ADDONS, true)).toEqual({
      channelsLimit: 8,
      membersLimit: 5,
      aiTokensLimit: 20000,
      queuedPostsPerChannel: -1,
    });
  });

  it('adds purchased channels and members to the primary workspace', () => {
    const addons: AddonQuantities = {
      ...NO_ADDONS,
      extraChannels: 2,
      extraMembers: 3,
      extraAiTokens: 5000,
    };
    expect(resolveWorkspaceLimits(PRO, addons, true)).toEqual({
      channelsLimit: 10,
      membersLimit: 8,
      aiTokensLimit: 25000,
      queuedPostsPerChannel: -1,
    });
  });

  // The arbitrage guard from the spec: a bought workspace arrives empty.
  it('grants a non-primary workspace zero channels and zero members', () => {
    const addons: AddonQuantities = {
      ...NO_ADDONS,
      extraChannels: 2,
      extraMembers: 3,
    };
    expect(resolveWorkspaceLimits(PRO, addons, false)).toEqual({
      channelsLimit: 0,
      membersLimit: 0,
      aiTokensLimit: 20000,
      queuedPostsPerChannel: -1,
    });
  });

  it('keeps the unlimited sentinel intact rather than doing arithmetic on it', () => {
    const addons: AddonQuantities = { ...NO_ADDONS, extraChannels: 5 };
    expect(resolveWorkspaceLimits(PRO, addons, true).queuedPostsPerChannel).toBe(-1);
  });

  it('passes a finite queue limit through unchanged', () => {
    expect(resolveWorkspaceLimits(FREE, NO_ADDONS, true).queuedPostsPerChannel).toBe(10);
  });
});

describe('resolveMaxWorkspaces', () => {
  it('returns the plan value when no workspaces are purchased', () => {
    expect(resolveMaxWorkspaces(PRO, NO_ADDONS)).toBe(3);
  });

  it('adds purchased workspaces to the plan value', () => {
    expect(resolveMaxWorkspaces(PRO, { ...NO_ADDONS, extraWorkspaces: 2 })).toBe(5);
  });

  it('lets a FREE user buy workspaces', () => {
    expect(resolveMaxWorkspaces(FREE, { ...NO_ADDONS, extraWorkspaces: 1 })).toBe(2);
  });
});

describe('canQueuePost', () => {
  it('allows a post below the limit', () => {
    expect(canQueuePost(10, 9)).toBe(true);
  });

  it('refuses a post at the limit', () => {
    expect(canQueuePost(10, 10)).toBe(false);
  });

  it('refuses a post above the limit', () => {
    expect(canQueuePost(10, 11)).toBe(false);
  });

  it('always allows when the limit is the unlimited sentinel', () => {
    expect(canQueuePost(-1, 9999)).toBe(true);
  });

  it('refuses everything when the limit is zero', () => {
    expect(canQueuePost(0, 0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- limit-resolver.util.spec`
Expected: FAIL — `Cannot find module './limit-resolver.util'`

- [ ] **Step 3: Write the implementation**

Create `src/billing/services/limit-resolver.util.ts`:

```ts
/**
 * Pure limit math for account-scoped billing. No DB, no NestJS — the numbers a
 * user is entitled to, derived from their single subscription.
 */

/** Sentinel: the plan places no ceiling on this resource. */
export const UNLIMITED = -1;

export interface PlanLimits {
  channelsPerWorkspace: number;
  membersPerWorkspace: number;
  maxWorkspaces: number;
  aiTokensPerMonth: number;
  queuedPostsPerChannel: number;
}

export interface AddonQuantities {
  extraChannels: number;
  extraMembers: number;
  extraWorkspaces: number;
  /** Already multiplied by addon_pricing.units_per_quantity (a pack = 5000). */
  extraAiTokens: number;
}

export interface ResolvedWorkspaceLimits {
  channelsLimit: number;
  membersLimit: number;
  aiTokensLimit: number;
  queuedPostsPerChannel: number;
}

/**
 * Resolve one workspace's limits from the owner's plan and add-ons.
 *
 * `isPrimaryWorkspace` decides where purchased channels and members land. A
 * workspace bought via EXTRA_WORKSPACE arrives EMPTY: channel limits are
 * per-workspace, so if a purchased workspace carried the tier's channel
 * allowance, buying a workspace would be a cheaper route to channels whenever
 * price(EXTRA_WORKSPACE) < channelsPerWorkspace x price(EXTRA_CHANNEL). Zero
 * closes that arbitrage — workspaces and channels are priced independently.
 */
export function resolveWorkspaceLimits(
  plan: PlanLimits,
  addons: AddonQuantities,
  isPrimaryWorkspace: boolean,
): ResolvedWorkspaceLimits {
  if (!isPrimaryWorkspace) {
    return {
      channelsLimit: 0,
      membersLimit: 0,
      aiTokensLimit: plan.aiTokensPerMonth,
      queuedPostsPerChannel: plan.queuedPostsPerChannel,
    };
  }

  return {
    channelsLimit: plan.channelsPerWorkspace + addons.extraChannels,
    membersLimit: plan.membersPerWorkspace + addons.extraMembers,
    aiTokensLimit: plan.aiTokensPerMonth + addons.extraAiTokens,
    queuedPostsPerChannel: plan.queuedPostsPerChannel,
  };
}

/** How many workspaces the account may own: the tier plus what it bought. */
export function resolveMaxWorkspaces(
  plan: PlanLimits,
  addons: AddonQuantities,
): number {
  return plan.maxWorkspaces + addons.extraWorkspaces;
}

/**
 * May another post be queued on this channel?
 *
 * `currentQueued` is a live COUNT of posts already in `scheduled` status, so it
 * self-corrects: publishing moves a post out of `scheduled` and frees the slot
 * with no bookkeeping.
 */
export function canQueuePost(
  queuedPostsPerChannel: number,
  currentQueued: number,
): boolean {
  if (queuedPostsPerChannel === UNLIMITED) return true;
  return currentQueued < queuedPostsPerChannel;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- limit-resolver.util.spec`
Expected: PASS, 13 tests.

- [ ] **Step 5: Lint and commit**

```bash
# npx eslint <files you changed>
git add src/billing/services/limit-resolver.util.ts src/billing/services/limit-resolver.util.spec.ts
git commit -m "feat(billing): pure limit-resolution helpers for account-scoped plans"
```

---

## Task 2: Usage fan-out helper

The fan-out this design makes necessary. One subscription now covers many workspaces, so a plan change must rewrite **every** owned workspace's limits — not one.

**Files:**
- Create: `src/billing/services/usage-fanout.util.ts`
- Test: `src/billing/services/usage-fanout.util.spec.ts`

**Interfaces:**
- Consumes: `resolveWorkspaceLimits`, `PlanLimits`, `AddonQuantities` from Task 1.
- Produces:
  ```ts
  export interface WorkspaceRef { id: string; createdAt: Date }
  export interface WorkspaceLimitWrite {
    workspaceId: string;
    channelsLimit: number;
    membersLimit: number;
    aiTokensLimit: number;
  }
  export function buildUsageFanout(
    workspaces: WorkspaceRef[], plan: PlanLimits, addons: AddonQuantities,
  ): WorkspaceLimitWrite[];
  export function pickPrimaryWorkspaceId(workspaces: WorkspaceRef[]): string | null;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/billing/services/usage-fanout.util.spec.ts`:

```ts
import { buildUsageFanout, pickPrimaryWorkspaceId, WorkspaceRef } from './usage-fanout.util';
import { PlanLimits, AddonQuantities } from './limit-resolver.util';

const PRO: PlanLimits = {
  channelsPerWorkspace: 8,
  membersPerWorkspace: 5,
  maxWorkspaces: 3,
  aiTokensPerMonth: 20000,
  queuedPostsPerChannel: -1,
};

const NO_ADDONS: AddonQuantities = {
  extraChannels: 0,
  extraMembers: 0,
  extraWorkspaces: 0,
  extraAiTokens: 0,
};

const d = (iso: string) => new Date(iso);

describe('pickPrimaryWorkspaceId', () => {
  it('returns the oldest workspace, whatever order it arrives in', () => {
    const workspaces: WorkspaceRef[] = [
      { id: 'b', createdAt: d('2026-03-01T00:00:00Z') },
      { id: 'a', createdAt: d('2026-01-01T00:00:00Z') },
      { id: 'c', createdAt: d('2026-02-01T00:00:00Z') },
    ];
    expect(pickPrimaryWorkspaceId(workspaces)).toBe('a');
  });

  it('returns null when the user owns nothing', () => {
    expect(pickPrimaryWorkspaceId([])).toBeNull();
  });
});

describe('buildUsageFanout', () => {
  it('produces one write per owned workspace', () => {
    const workspaces: WorkspaceRef[] = [
      { id: 'a', createdAt: d('2026-01-01T00:00:00Z') },
      { id: 'b', createdAt: d('2026-02-01T00:00:00Z') },
      { id: 'c', createdAt: d('2026-03-01T00:00:00Z') },
    ];
    const writes = buildUsageFanout(workspaces, PRO, NO_ADDONS);
    expect(writes).toHaveLength(3);
    expect(writes.map((w) => w.workspaceId).sort()).toEqual(['a', 'b', 'c']);
  });

  // This is the whole point of the task: the old code wrote ONE row.
  it('gives the primary workspace the plan allowance and the rest zero channels', () => {
    const workspaces: WorkspaceRef[] = [
      { id: 'primary', createdAt: d('2026-01-01T00:00:00Z') },
      { id: 'second', createdAt: d('2026-02-01T00:00:00Z') },
    ];
    const writes = buildUsageFanout(workspaces, PRO, NO_ADDONS);
    const primary = writes.find((w) => w.workspaceId === 'primary');
    const second = writes.find((w) => w.workspaceId === 'second');

    expect(primary).toEqual({
      workspaceId: 'primary',
      channelsLimit: 8,
      membersLimit: 5,
      aiTokensLimit: 20000,
    });
    expect(second).toEqual({
      workspaceId: 'second',
      channelsLimit: 0,
      membersLimit: 0,
      aiTokensLimit: 20000,
    });
  });

  it('routes purchased channels to the primary workspace only', () => {
    const workspaces: WorkspaceRef[] = [
      { id: 'primary', createdAt: d('2026-01-01T00:00:00Z') },
      { id: 'second', createdAt: d('2026-02-01T00:00:00Z') },
    ];
    const writes = buildUsageFanout(workspaces, PRO, {
      ...NO_ADDONS,
      extraChannels: 4,
    });
    expect(writes.find((w) => w.workspaceId === 'primary')!.channelsLimit).toBe(12);
    expect(writes.find((w) => w.workspaceId === 'second')!.channelsLimit).toBe(0);
  });

  it('returns no writes when the user owns no workspaces', () => {
    expect(buildUsageFanout([], PRO, NO_ADDONS)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- usage-fanout.util.spec`
Expected: FAIL — `Cannot find module './usage-fanout.util'`

- [ ] **Step 3: Write the implementation**

Create `src/billing/services/usage-fanout.util.ts`:

```ts
import {
  resolveWorkspaceLimits,
  PlanLimits,
  AddonQuantities,
} from './limit-resolver.util';

export interface WorkspaceRef {
  id: string;
  createdAt: Date;
}

export interface WorkspaceLimitWrite {
  workspaceId: string;
  channelsLimit: number;
  membersLimit: number;
  aiTokensLimit: number;
}

/**
 * The account's primary workspace is its oldest one. Purchased channels and
 * member seats land here; every other workspace the account owns arrives empty
 * (see resolveWorkspaceLimits for why).
 *
 * Oldest-wins is stable: it does not move when a workspace is added or renamed,
 * so a user's channels do not silently migrate between workspaces.
 */
export function pickPrimaryWorkspaceId(
  workspaces: WorkspaceRef[],
): string | null {
  if (workspaces.length === 0) return null;
  return workspaces.reduce((oldest, ws) =>
    ws.createdAt.getTime() < oldest.createdAt.getTime() ? ws : oldest,
  ).id;
}

/**
 * Build the workspace_usage limit writes for EVERY workspace the account owns.
 *
 * Before account-scoped billing a subscription mapped to exactly one workspace,
 * so limit changes wrote a single row. One subscription now covers many
 * workspaces: writing one row would leave the others on their previous plan's
 * limits — silently, with no error. Every caller that changes a plan or an
 * add-on must write all of these.
 */
export function buildUsageFanout(
  workspaces: WorkspaceRef[],
  plan: PlanLimits,
  addons: AddonQuantities,
): WorkspaceLimitWrite[] {
  const primaryId = pickPrimaryWorkspaceId(workspaces);

  return workspaces.map((ws) => {
    const limits = resolveWorkspaceLimits(plan, addons, ws.id === primaryId);
    return {
      workspaceId: ws.id,
      channelsLimit: limits.channelsLimit,
      membersLimit: limits.membersLimit,
      aiTokensLimit: limits.aiTokensLimit,
    };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- usage-fanout.util.spec`
Expected: PASS, 6 tests.

- [ ] **Step 5: Lint and commit**

```bash
# npx eslint <files you changed>
git add src/billing/services/usage-fanout.util.ts src/billing/services/usage-fanout.util.spec.ts
git commit -m "feat(billing): fan out workspace limits across every workspace an account owns"
```

---

## Task 3: Schema change + migration

**Files:**
- Modify: `src/drizzle/schema/billing.schema.ts`
- Create: `drizzle/migrations/0030_billing_account_scope.sql`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `subscriptions.userId` (uuid, unique, FK `users.id` cascade) replacing `subscriptions.workspaceId`; `subscriptions.stripeCustomerId` nullable; `plans.queuedPostsPerChannel` (integer, not null).

- [ ] **Step 1: Write the migration**

Create `drizzle/migrations/0030_billing_account_scope.sql`:

```sql
-- Billing moves from workspace scope to account (user) scope.
--
-- Safe to truncate: at the time of writing only 2 subscriptions exist, both
-- Stripe TEST mode on the team's own accounts. No real money has moved. If a
-- live-mode subscription exists when this runs, STOP and migrate instead.

BEGIN;

-- 1. Clear billing state. Order respects FKs.
DELETE FROM failed_payments;
DELETE FROM invoice_line_items;
DELETE FROM invoices;
DELETE FROM billing_events;
DELETE FROM subscription_changes;
DELETE FROM subscription_items;
DELETE FROM subscriptions;

-- 2. Re-scope subscriptions to the user.
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_workspace_id_workspace_id_fk;
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_workspace_id_unique;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS workspace_id;

ALTER TABLE subscriptions ADD COLUMN user_id uuid NOT NULL;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_user_id_unique UNIQUE (user_id);
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- 3. A second billing provider arrives in a later effort; making this nullable
--    now means that effort needs no migration of its own.
ALTER TABLE subscriptions ALTER COLUMN stripe_customer_id DROP NOT NULL;

-- 4. Queued-post ceiling per channel. -1 means unlimited.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS queued_posts_per_channel integer NOT NULL DEFAULT -1;

COMMIT;
```

- [ ] **Step 2: Update the Drizzle schema**

In `src/drizzle/schema/billing.schema.ts`, replace the `workspaceId` field in the `subscriptions` table (currently lines 76-79) with:

```ts
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
```

Change `stripeCustomerId` on the same table to nullable by dropping `.notNull()`:

```ts
  stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),
```

Add to the `plans` table, after `maxWorkspaces`:

```ts
  // -1 = unlimited. Caps posts sitting in `scheduled` status per channel;
  // publishing frees the slot, so there is no counter to reset.
  queuedPostsPerChannel: integer('queued_posts_per_channel')
    .notNull()
    .default(-1),
```

Update the comment above the table from `// 4. Subscriptions - Per-workspace subscriptions` to `// 4. Subscriptions - Per-user (account) subscriptions`.

Update `subscriptionsRelations` — replace the `workspace` relation with:

```ts
    user: one(users, {
      fields: [subscriptions.userId],
      references: [users.id],
    }),
```

- [ ] **Step 3: Verify the schema compiles**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -40`
Expected: errors ONLY in the call sites Tasks 4-9 will fix (`usage.service.ts`, `subscription.service.ts`, `webhook.service.ts`, `addon.service.ts`, `plan-change.service.ts`, `invoice.service.ts`, `dashboard.service.ts`, `admin.service.ts`, `ai-token.service.ts`, `chatbot.service.ts`, `workspace-suspended.guard.ts`, `subscription-sync.util.ts`, `backfill-invoices.ts`). Every error should mention `workspaceId`. If any error names a different property, stop and report it.

Record the error count — later tasks drive it to zero.

- [ ] **Step 4: Commit**

```bash
# lint only what this task touched — see Global Constraints
git add src/drizzle/schema/billing.schema.ts drizzle/migrations/0030_billing_account_scope.sql
git commit -m "feat(billing): scope subscriptions to the user, add queued-post plan limit"
```

Note: at this point the build is intentionally broken — later tasks fix the call sites. Lint only the two files this task touched (`npx eslint src/drizzle/schema/billing.schema.ts`); the migration is `.sql` and eslint does not apply to it.

---

## Task 4: Subscription lookup service

One place that answers "which subscription applies here?" — so the 37 scattered call sites converge on a single seam.

**Files:**
- Create: `src/billing/services/subscription-lookup.service.ts`
- Test: `src/billing/services/subscription-lookup.service.spec.ts`
- Modify: `src/billing/billing.module.ts`

**Interfaces:**
- Consumes: `AddonQuantities`, `PlanLimits` from Task 1.
- Produces:
  ```ts
  @Injectable() export class SubscriptionLookupService {
    findByUserId(userId: string): Promise<Subscription | null>;
    findByWorkspaceId(workspaceId: string): Promise<Subscription | null>;  // via workspace.ownerId
    getOwnerId(workspaceId: string): Promise<string | null>;
    getPlanLimits(planCode: string): Promise<PlanLimits>;
    getAddonQuantities(subscriptionId: number): Promise<AddonQuantities>;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `src/billing/services/subscription-lookup.service.spec.ts`. Only the FREE-fallback branch is unit-tested here — the query paths are covered by the integration checks in Task 12.

```ts
import { SubscriptionLookupService } from './subscription-lookup.service';

describe('SubscriptionLookupService.toAddonQuantities', () => {
  it('maps subscription items onto add-on quantities', () => {
    const items = [
      { itemType: 'BASE_PLAN', quantity: 1 },
      { itemType: 'EXTRA_CHANNEL', quantity: 3 },
      { itemType: 'EXTRA_MEMBER', quantity: 2 },
      { itemType: 'EXTRA_WORKSPACE', quantity: 1 },
    ];
    expect(SubscriptionLookupService.toAddonQuantities(items, {})).toEqual({
      extraChannels: 3,
      extraMembers: 2,
      extraWorkspaces: 1,
      extraAiTokens: 0,
    });
  });

  it('multiplies an AI-token pack by its units-per-quantity', () => {
    const items = [{ itemType: 'EXTRA_AI_TOKENS', quantity: 2 }];
    expect(
      SubscriptionLookupService.toAddonQuantities(items, { EXTRA_AI_TOKENS: 5000 }),
    ).toEqual({
      extraChannels: 0,
      extraMembers: 0,
      extraWorkspaces: 0,
      extraAiTokens: 10000,
    });
  });

  it('ignores an unrecognised item type rather than throwing', () => {
    const items = [{ itemType: 'SOMETHING_NEW', quantity: 9 }];
    expect(SubscriptionLookupService.toAddonQuantities(items, {})).toEqual({
      extraChannels: 0,
      extraMembers: 0,
      extraWorkspaces: 0,
      extraAiTokens: 0,
    });
  });

  it('returns all zeroes for an empty item list', () => {
    expect(SubscriptionLookupService.toAddonQuantities([], {})).toEqual({
      extraChannels: 0,
      extraMembers: 0,
      extraWorkspaces: 0,
      extraAiTokens: 0,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- subscription-lookup.service.spec`
Expected: FAIL — `Cannot find module './subscription-lookup.service'`

- [ ] **Step 3: Write the implementation**

Create `src/billing/services/subscription-lookup.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import {
  subscriptions,
  subscriptionItems,
  plans,
  workspace,
  Subscription,
} from '../../drizzle/schema';
import { PlanLimits, AddonQuantities } from './limit-resolver.util';

/** Limits every account falls back to when it has no subscription row. */
const FREE_FALLBACK: PlanLimits = {
  channelsPerWorkspace: 3,
  membersPerWorkspace: 1,
  maxWorkspaces: 1,
  aiTokensPerMonth: 0,
  queuedPostsPerChannel: 10,
};

interface AddonItemRow {
  itemType: string;
  quantity: number;
}

/**
 * The single seam through which billing finds "the subscription that applies".
 *
 * Subscriptions are account-scoped, but most of the app still asks its
 * questions per workspace ("can this workspace add a channel?"). Rather than
 * teach 37 call sites to resolve an owner, they all come through here.
 */
@Injectable()
export class SubscriptionLookupService {
  private readonly logger = new Logger(SubscriptionLookupService.name);

  async findByUserId(userId: string): Promise<Subscription | null> {
    const rows = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  async getOwnerId(workspaceId: string): Promise<string | null> {
    const rows = await db
      .select({ ownerId: workspace.ownerId })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);
    return rows[0]?.ownerId ?? null;
  }

  /** The subscription that pays for this workspace: its owner's. */
  async findByWorkspaceId(workspaceId: string): Promise<Subscription | null> {
    const ownerId = await this.getOwnerId(workspaceId);
    if (!ownerId) return null;
    return this.findByUserId(ownerId);
  }

  /**
   * A missing plan row falls back to FREE rather than throwing. Billing is
   * read on hot paths (guards, post creation); an unknown plan code must
   * degrade to the smallest allowance, never take the request down.
   */
  async getPlanLimits(planCode: string): Promise<PlanLimits> {
    const rows = await db
      .select()
      .from(plans)
      .where(eq(plans.code, planCode))
      .limit(1);

    const plan = rows[0];
    if (!plan) {
      this.logger.warn(`Plan "${planCode}" not found — falling back to FREE limits`);
      return FREE_FALLBACK;
    }

    return {
      channelsPerWorkspace: plan.channelsPerWorkspace,
      membersPerWorkspace: plan.membersPerWorkspace,
      maxWorkspaces: plan.maxWorkspaces,
      aiTokensPerMonth: plan.aiTokensPerMonth,
      queuedPostsPerChannel: plan.queuedPostsPerChannel,
    };
  }

  /** Pure: fold subscription items into add-on quantities. */
  static toAddonQuantities(
    items: AddonItemRow[],
    unitsByType: Record<string, number>,
  ): AddonQuantities {
    const quantities: AddonQuantities = {
      extraChannels: 0,
      extraMembers: 0,
      extraWorkspaces: 0,
      extraAiTokens: 0,
    };

    for (const item of items) {
      const units = unitsByType[item.itemType] ?? 1;
      if (item.itemType === 'EXTRA_CHANNEL') {
        quantities.extraChannels += item.quantity;
      } else if (item.itemType === 'EXTRA_MEMBER') {
        quantities.extraMembers += item.quantity;
      } else if (item.itemType === 'EXTRA_WORKSPACE') {
        quantities.extraWorkspaces += item.quantity;
      } else if (item.itemType === 'EXTRA_AI_TOKENS') {
        quantities.extraAiTokens += item.quantity * units;
      }
      // BASE_PLAN and anything unrecognised contribute nothing.
    }

    return quantities;
  }

  async getAddonQuantities(subscriptionId: number): Promise<AddonQuantities> {
    const items = await db
      .select({
        itemType: subscriptionItems.itemType,
        quantity: subscriptionItems.quantity,
      })
      .from(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, subscriptionId));

    // An AI-token pack grants 5000 tokens per purchased unit, not 1.
    const unitsByType: Record<string, number> = { EXTRA_AI_TOKENS: 5000 };

    return SubscriptionLookupService.toAddonQuantities(items, unitsByType);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- subscription-lookup.service.spec`
Expected: PASS, 4 tests.

- [ ] **Step 5: Register the service**

In `src/billing/billing.module.ts`, import `SubscriptionLookupService` and add it to both the `providers` array and the `exports` array. It is consumed outside the billing module (by `ai-token.service.ts`, `chatbot.service.ts`, and `workspace-suspended.guard.ts`), so the export is required.

- [ ] **Step 6: Verify it compiles and commit**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep "subscription-lookup" | head -5`
Expected: no output (this file itself compiles; the pre-existing errors from Task 3 remain).

```bash
git add src/billing/services/subscription-lookup.service.ts src/billing/services/subscription-lookup.service.spec.ts src/billing/billing.module.ts
git commit -m "feat(billing): single lookup seam for account-scoped subscriptions"
```

---

## Task 5: Queued-post limit service

**Files:**
- Create: `src/billing/services/post-queue.service.ts`
- Test: `src/billing/services/post-queue.service.spec.ts`
- Modify: `src/billing/billing.module.ts`

**Interfaces:**
- Consumes: `canQueuePost` (Task 1), `SubscriptionLookupService` (Task 4).
- Produces:
  ```ts
  @Injectable() export class PostQueueService {
    countQueuedForChannel(workspaceId: string, channelId: string): Promise<number>;
    enforceQueueLimit(workspaceId: string, channelIds: string[]): Promise<void>;
  }
  export function buildQueuedTargetJson(channelId: string | number): string;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/billing/services/post-queue.service.spec.ts`. The value under test is the SQL shape — specifically that the channel id is stringified, because `posts.targets[].channelId` is written as a string even though channel ids are bigints. A number here matches nothing and the limit silently never fires.

```ts
import { buildQueuedTargetJson } from './post-queue.service';

describe('buildQueuedTargetJson', () => {
  // posts.targets[].channelId is written as String(channel.id)
  // (post.service.ts:144) even though social_media_channels.id is a bigint.
  // A numeric probe would match nothing and the limit would never fire.
  it('stringifies a numeric channel id', () => {
    expect(buildQueuedTargetJson(12345)).toBe('[{"channelId":"12345"}]');
  });

  it('leaves an already-string channel id alone', () => {
    expect(buildQueuedTargetJson('12345')).toBe('[{"channelId":"12345"}]');
  });

  it('probes only channelId, so a target matches whatever else it carries', () => {
    const parsed = JSON.parse(
      buildQueuedTargetJson('7'),
    ) as Record<string, unknown>[];
    expect(Object.keys(parsed[0])).toEqual(['channelId']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- post-queue.service.spec`
Expected: FAIL — `Cannot find module './post-queue.service'`

- [ ] **Step 3: Write the implementation**

Create `src/billing/services/post-queue.service.ts`:

```ts
import { Injectable, ForbiddenException, Logger } from '@nestjs/common';
import { eq, and, sql, count } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { posts } from '../../drizzle/schema';
import { SubscriptionLookupService } from './subscription-lookup.service';
import { canQueuePost, UNLIMITED } from './limit-resolver.util';

/**
 * Build the jsonb containment probe for one channel.
 *
 * There is no post_targets table: a post's channels live in `posts.targets`, a
 * jsonb array of PostTarget objects. `@>` containment matches a row whose array
 * holds an object with these keys, so probing on channelId alone matches a
 * target regardless of its platform or per-target status.
 *
 * The id MUST be a string. post.service.ts writes String(channel.id) even
 * though social_media_channels.id is a bigint; a numeric probe matches nothing.
 */
export function buildQueuedTargetJson(channelId: string | number): string {
  return JSON.stringify([{ channelId: String(channelId) }]);
}

@Injectable()
export class PostQueueService {
  private readonly logger = new Logger(PostQueueService.name);

  constructor(private readonly lookup: SubscriptionLookupService) {}

  /**
   * Count posts still queued on a channel.
   *
   * Post-level status gates the row; the jsonb target carries the channel.
   * A partially-published post is deliberately NOT counted: its post-level
   * status has already left `scheduled`, so its remaining targets hold no
   * slot. Counting per-target status instead would hold a slot open on a post
   * the user considers sent.
   */
  async countQueuedForChannel(
    workspaceId: string,
    channelId: string,
  ): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(posts)
      .where(
        and(
          eq(posts.workspaceId, workspaceId),
          eq(posts.status, 'scheduled'),
          sql`${posts.targets} @> ${buildQueuedTargetJson(channelId)}::jsonb`,
        ),
      );

    return Number(row?.n ?? 0);
  }

  /**
   * Refuse the schedule if any target channel is already at its queue ceiling.
   *
   * Checked per channel, not per post: a post targeting three channels
   * occupies one slot on each.
   */
  async enforceQueueLimit(
    workspaceId: string,
    channelIds: string[],
  ): Promise<void> {
    if (channelIds.length === 0) return;

    const subscription = await this.lookup.findByWorkspaceId(workspaceId);
    const planCode = subscription?.planCode ?? 'FREE';
    const plan = await this.lookup.getPlanLimits(planCode);

    // Cheapest possible exit for every paid tier.
    if (plan.queuedPostsPerChannel === UNLIMITED) return;

    for (const channelId of channelIds) {
      const queued = await this.countQueuedForChannel(workspaceId, channelId);
      if (!canQueuePost(plan.queuedPostsPerChannel, queued)) {
        throw new ForbiddenException(
          `Scheduling queue full. This channel has ${queued} of ${plan.queuedPostsPerChannel} scheduled posts. ` +
            'Publish or remove a scheduled post, or upgrade for unlimited scheduling.',
        );
      }
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- post-queue.service.spec`
Expected: PASS, 3 tests.

- [ ] **Step 5: Register the service**

In `src/billing/billing.module.ts`, add `PostQueueService` to `providers` and `exports` (the posts module consumes it in Task 9).

- [ ] **Step 6: Lint and commit**

```bash
# lint only what this task touched — see Global Constraints
git add src/billing/services/post-queue.service.ts src/billing/services/post-queue.service.spec.ts src/billing/billing.module.ts
git commit -m "feat(billing): queued-post limit per channel"
```

---

## Task 6: Rewrite usage.service.ts

The `getWorkspaceLimits` loop — the exploitable "keep the largest plan across all workspaces" workaround — disappears here.

**Files:**
- Modify: `src/billing/services/usage.service.ts`
- Test: `src/billing/services/usage.service.spec.ts` (create)

**Interfaces:**
- Consumes: `SubscriptionLookupService` (Task 4), `resolveMaxWorkspaces` (Task 1).
- Produces: `UsageService.getWorkspaceLimits(userId)` unchanged in signature and return shape (`WorkspaceLimits`), changed in behaviour: one subscription lookup, no loop.

- [ ] **Step 1: Write the failing test**

Create `src/billing/services/usage.service.spec.ts`:

```ts
import { ResourceType } from './usage.service';

describe('ResourceType', () => {
  // Post limits are enforced live over `scheduled` rows, but usage_events
  // records a POST resource type so the audit trail can carry the refusal.
  it('includes POST', () => {
    const t: ResourceType = 'POST';
    expect(t).toBe('POST');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- usage.service.spec`
Expected: FAIL — TypeScript error, `'POST'` is not assignable to type `ResourceType`.

- [ ] **Step 3: Rewrite `getWorkspaceLimits`**

In `src/billing/services/usage.service.ts`:

First widen the type union at line 20:

```ts
export type ResourceType = 'CHANNEL' | 'MEMBER' | 'WORKSPACE' | 'POST';
```

Inject the lookup service — change the class to have a constructor:

```ts
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(private readonly lookup: SubscriptionLookupService) {}
```

Add the import at the top:

```ts
import { SubscriptionLookupService } from './subscription-lookup.service';
import { resolveMaxWorkspaces } from './limit-resolver.util';
```

Then replace the whole of `getWorkspaceLimits` (currently lines 91-147) with:

```ts
  /**
   * How many workspaces this account may own.
   *
   * Previously this looped over every workspace the user owned, read each
   * one's own subscription, and kept the LARGEST maxWorkspaces it found — a
   * workaround for workspace-scoped billing that was also exploitable (buy MAX
   * on one workspace, FREE on another, and MAX's allowance applied to both).
   * One account, one subscription, one lookup.
   */
  async getWorkspaceLimits(userId: string): Promise<WorkspaceLimits> {
    const userWorkspaces = await db
      .select({ id: workspace.id })
      .from(workspace)
      .where(eq(workspace.ownerId, userId));

    const subscription = await this.lookup.findByUserId(userId);

    // No subscription, or one that is not active, gets FREE's allowance.
    const planCode =
      subscription && subscription.status === 'active'
        ? subscription.planCode
        : 'FREE';

    const plan = await this.lookup.getPlanLimits(planCode);
    const addons = subscription
      ? await this.lookup.getAddonQuantities(subscription.id)
      : { extraChannels: 0, extraMembers: 0, extraWorkspaces: 0, extraAiTokens: 0 };

    const maxWorkspaces = resolveMaxWorkspaces(plan, addons);

    return {
      maxWorkspaces,
      currentWorkspaces: userWorkspaces.length,
      workspacesAvailable: maxWorkspaces - userWorkspaces.length,
    };
  }
```

Remove the now-unused `subscriptions`, `plans`, and `subscriptionItems` imports **only if** no other method in the file still uses them — check with `grep -n "subscriptions\|subscriptionItems" src/billing/services/usage.service.ts` before deleting. `plans` is still used by `canDowngrade`, so keep it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- usage.service.spec`
Expected: PASS, 1 test.

- [ ] **Step 5: Verify the file compiles**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep "usage.service.ts" | head`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
# lint only what this task touched — see Global Constraints
git add src/billing/services/usage.service.ts src/billing/services/usage.service.spec.ts
git commit -m "fix(billing): resolve workspace allowance from one account subscription"
```

---

## Task 7: Subscription + sync service to user scope

**Files:**
- Modify: `src/billing/services/subscription.service.ts`
- Modify: `src/billing/services/subscription-sync.util.ts`
- Modify: `src/billing/services/subscription-sync.util.spec.ts`

**Interfaces:**
- Consumes: `buildUsageFanout` (Task 2), `SubscriptionLookupService` (Task 4).
- Produces: `buildSubscriptionSync` takes `userId` instead of `workspaceId` and returns `usageRows: WorkspaceLimitWrite[]` (plural) instead of a single `usageRow`. `SubscriptionService.persistStripeSubscription` takes `{ userId, planCode, stripeCustomerId, stripeSubscription }`.

- [ ] **Step 1: Update the sync util's test first**

In `src/billing/services/subscription-sync.util.spec.ts`, change every `workspaceId:` input to `userId:`, add a `workspaces` array input, and change assertions on `usageRow` to `usageRows`. Add this test, which pins the behaviour that the old single-row version could not express:

```ts
  it('emits a usage row for every workspace the account owns', () => {
    const result = buildSubscriptionSync({
      userId: 'user-1',
      workspaces: [
        { id: 'ws-a', createdAt: new Date('2026-01-01T00:00:00Z') },
        { id: 'ws-b', createdAt: new Date('2026-02-01T00:00:00Z') },
      ],
      planCode: 'PRO',
      plan: {
        basePriceCents: 1500,
        channelsPerWorkspace: 8,
        membersPerWorkspace: 5,
        maxWorkspaces: 3,
        aiTokensPerMonth: 20000,
        queuedPostsPerChannel: -1,
      },
      addons: {
        extraChannels: 0,
        extraMembers: 0,
        extraWorkspaces: 0,
        extraAiTokens: 0,
      },
      stripeCustomerId: 'cus_test',
      stripeSubscription: {
        id: 'sub_test',
        status: 'active',
        cancel_at_period_end: false,
        items: { data: [{ id: 'si_test', price: { id: 'price_test' }, current_period_start: 1767225600, current_period_end: 1769904000 }] },
      } as any,
    });

    expect(result.usageRows).toHaveLength(2);
    expect(result.usageRows.find((r) => r.workspaceId === 'ws-a')!.channelsLimit).toBe(8);
    // The second workspace arrives empty — the arbitrage guard.
    expect(result.usageRows.find((r) => r.workspaceId === 'ws-b')!.channelsLimit).toBe(0);
    expect(result.subscriptionRow.userId).toBe('user-1');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- subscription-sync.util.spec`
Expected: FAIL — `usageRows` is undefined / `userId` not accepted.

- [ ] **Step 3: Update `subscription-sync.util.ts`**

Replace `SubscriptionSyncInput` and the relevant parts of `buildSubscriptionSync`:

```ts
import type Stripe from 'stripe';
import { PlanLimits, AddonQuantities } from './limit-resolver.util';
import {
  buildUsageFanout,
  WorkspaceRef,
  WorkspaceLimitWrite,
} from './usage-fanout.util';

export interface SubscriptionSyncInput {
  userId: string;
  /** Every workspace the account owns — limits fan out across all of them. */
  workspaces: WorkspaceRef[];
  planCode: string;
  plan: PlanLimits & { basePriceCents: number };
  addons: AddonQuantities;
  stripeCustomerId: string;
  stripeSubscription: Stripe.Subscription;
}

export interface SubscriptionSyncValues {
  subscriptionRow: Record<string, unknown>;
  baseItem: Record<string, unknown>;
  /** One row per owned workspace. Was a single row under workspace billing. */
  usageRows: (WorkspaceLimitWrite & Record<string, unknown>)[];
}
```

Keep `getSubscriptionPeriod` exactly as it is. In `buildSubscriptionSync`, change `workspaceId: input.workspaceId` to `userId: input.userId` in `subscriptionRow`, keep `baseItem` unchanged, and replace the `usageRow` construction with:

```ts
  // Mirror createFreeSubscription's defaults for NOT-NULL count fields so an
  // upsert-insert (no workspace_usage row yet) satisfies every constraint.
  const usageRows = buildUsageFanout(
    input.workspaces,
    input.plan,
    input.addons,
  ).map((write) => ({
    ...write,
    channelsCount: 0,
    extraChannelsPurchased: 0,
    membersCount: 0,
    extraMembersPurchased: 0,
  }));

  return { subscriptionRow, baseItem, usageRows };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- subscription-sync.util.spec`
Expected: PASS.

- [ ] **Step 5: Update `subscription.service.ts`**

Apply these changes:

1. Inject `SubscriptionLookupService` into the constructor.
2. `createSubscription` (around line 82): change the "workspace already has a subscription" check from a workspace lookup to a user lookup:
   ```ts
   const existingSub = await db
     .select()
     .from(subscriptions)
     .where(eq(subscriptions.userId, dto.userId))
     .limit(1);

   if (existingSub.length > 0) {
     throw new BadRequestException('You already have a subscription');
   }
   ```
   Keep the workspace-ownership validation above it — it still proves the caller owns the workspace they named.
3. `createFreeSubscription(workspaceId, ...)` becomes `createFreeSubscription(userId, workspaces, ...)`, inserting `userId` and writing a usage row for each workspace.
4. `persistStripeSubscription`: change the input to `{ userId, planCode, stripeCustomerId, stripeSubscription }`. Load the owner's workspaces and add-ons, then:
   ```ts
   const workspaces = await db
     .select({ id: workspace.id, createdAt: workspace.createdAt })
     .from(workspace)
     .where(eq(workspace.ownerId, input.userId));

   const { subscriptionRow, baseItem, usageRows } = buildSubscriptionSync({
     userId: input.userId,
     workspaces,
     planCode: input.planCode,
     plan: { ...planLimits, basePriceCents: plan.basePriceCents },
     addons,
     stripeCustomerId: input.stripeCustomerId,
     stripeSubscription: input.stripeSubscription,
   });
   ```
   Change the conflict target from `subscriptions.workspaceId` to `subscriptions.userId`, change the subscription-id re-read to `.where(eq(subscriptions.userId, input.userId))`, and replace the single `workspaceUsage` upsert with a loop over `usageRows` performing the same upsert per row (same `onConflictDoUpdate` target and set).
5. `getSubscriptionByWorkspaceId(workspaceId)`: keep the name and signature — callers depend on it — but resolve through the owner:
   ```ts
   const subscription = await this.lookup.findByWorkspaceId(workspaceId);
   if (!subscription) {
     throw new NotFoundException('Subscription not found for this workspace');
   }
   return subscription;
   ```
6. `cancelSubscription(workspaceId, userId, ...)`: change the subscription lookup to `eq(subscriptions.userId, userId)`.

- [ ] **Step 6: Verify and commit**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "subscription.service.ts|subscription-sync" | head`
Expected: no output.

```bash
# lint only what this task touched — see Global Constraints
git add src/billing/services/subscription.service.ts src/billing/services/subscription-sync.util.ts src/billing/services/subscription-sync.util.spec.ts
git commit -m "feat(billing): persist subscriptions per account and fan usage out"
```

---

## Task 8: Webhook, add-on, plan-change, invoice, dashboard fan-out

The five limit-write sites. This is where a missed edit silently strands a workspace on stale limits, so all five move together and a test pins the count.

**Files:**
- Modify: `src/billing/services/webhook.service.ts`
- Modify: `src/billing/services/addon.service.ts`
- Modify: `src/billing/services/plan-change.service.ts`
- Modify: `src/billing/services/invoice.service.ts`
- Modify: `src/billing/services/dashboard.service.ts`

**Interfaces:**
- Consumes: `buildUsageFanout` (Task 2), `SubscriptionLookupService` (Task 4).
- Produces: a shared private helper on each service, or better, add this method to `SubscriptionLookupService` and call it from all five:
  ```ts
  // Add to SubscriptionLookupService:
  applyLimitsToAllWorkspaces(userId: string, planCode: string, addons: AddonQuantities): Promise<void>;
  ```

- [ ] **Step 1: Add the shared fan-out writer**

Add to `src/billing/services/subscription-lookup.service.ts`:

```ts
  /**
   * Write plan limits to EVERY workspace the account owns.
   *
   * Under workspace-scoped billing each of these writes targeted a single
   * usage row. One subscription now covers many workspaces, so writing one row
   * would leave the rest on their previous limits with no error raised. Every
   * plan change, add-on change, downgrade, and reset-to-FREE goes through here.
   */
  async applyLimitsToAllWorkspaces(
    userId: string,
    planCode: string,
    addons: AddonQuantities,
  ): Promise<void> {
    const workspaces = await db
      .select({ id: workspace.id, createdAt: workspace.createdAt })
      .from(workspace)
      .where(eq(workspace.ownerId, userId));

    if (workspaces.length === 0) return;

    const plan = await this.getPlanLimits(planCode);
    const writes = buildUsageFanout(workspaces, plan, addons);

    for (const write of writes) {
      await db
        .update(workspaceUsage)
        .set({
          channelsLimit: write.channelsLimit,
          membersLimit: write.membersLimit,
          aiTokensLimit: write.aiTokensLimit,
          updatedAt: new Date(),
        })
        .where(eq(workspaceUsage.workspaceId, write.workspaceId));
    }

    this.logger.log(
      `Applied ${planCode} limits to ${writes.length} workspace(s) for user ${userId}`,
    );
  }
```

Add `workspaceUsage` to the schema imports and `buildUsageFanout` to the util imports in that file.

- [ ] **Step 2: Update `webhook.service.ts`**

Three changes:

1. `handleCheckoutCompleted` (around line 168-198): read `userId` from metadata instead of `workspaceId`. The checkout session must now carry `userId` — verify `subscription.service.ts`'s `createCheckoutSession` sets it in `metadata` (Task 7 step 5 covers the persist path; if the metadata write is missing, add `userId` alongside the existing `planCode`). Pass `userId` to `persistStripeSubscription`.

2. `applyScheduledDowngrade` (around line 297-308): replace the single `workspaceUsage` update with:
   ```ts
   const addons = await this.lookup.getAddonQuantities(existing.id);
   await this.lookup.applyLimitsToAllWorkspaces(
     existing.userId,
     scheduledPlanCode,
     addons,
   );
   ```

3. `handleSubscriptionDeleted` (around line 350-364): replace the single `workspaceUsage` update with a reset that also zeroes add-ons. Because add-on items are deleted immediately after, pass zeroes explicitly:
   ```ts
   await this.lookup.applyLimitsToAllWorkspaces(existing.userId, 'FREE', {
     extraChannels: 0,
     extraMembers: 0,
     extraWorkspaces: 0,
     extraAiTokens: 0,
   });

   // The purchased extras die with the subscription.
   await db
     .update(workspaceUsage)
     .set({
       extraChannelsPurchased: 0,
       extraMembersPurchased: 0,
       extraAiTokensPurchased: 0,
       updatedAt: new Date(),
     })
     .where(
       inArray(
         workspaceUsage.workspaceId,
         db.select({ id: workspace.id }).from(workspace).where(eq(workspace.ownerId, existing.userId)),
       ),
     );
   ```
   Import `inArray` from `drizzle-orm` and `workspace` from the schema.

4. The payment-failure restrict/restore paths (`applyPaymentFailureRestrictions` around line 679-706, `removePaymentFailureRestrictions` around line 713-758): both take a `workspaceId` today. Change both to take `userId` and apply across all owned workspaces using the same `inArray` sub-select pattern. Update their two call sites (around lines 505 and 553) to pass `subscription[0].userId`.

- [ ] **Step 3: Update the remaining four services**

- `addon.service.ts`: change all four `eq(subscriptions.workspaceId, workspaceId)` lookups (lines 88, 335, 488, 544) to resolve the owner first via `this.lookup.getOwnerId(workspaceId)` then `eq(subscriptions.userId, ownerId)`. In `updateUsageLimitsForAddon` (line 588), after updating `workspace_usage`'s `extra*Purchased` on the primary workspace, call `applyLimitsToAllWorkspaces` so every workspace re-derives its limits. Add an `EXTRA_WORKSPACE` branch that does NOT touch `workspace_usage` — purchased workspaces change `maxWorkspaces`, which is computed live by `getWorkspaceLimits`, not materialized.
- `plan-change.service.ts`: four lookups (lines 110, 251, 593, 691) → owner-resolved. Wherever it writes new plan limits, route through `applyLimitsToAllWorkspaces`.
- `invoice.service.ts`: three lookups (lines 69, 195, 344) → owner-resolved. Read-only; no limit writes.
- `dashboard.service.ts`: three lookups (lines 109, 278, 347) → owner-resolved. Read-only.

- [ ] **Step 4: Verify no by-workspace subscription lookups remain in billing**

Run: `grep -rn "subscriptions.workspaceId" src/billing/`
Expected: **no output**. Any remaining hit is a missed site.

- [ ] **Step 5: Verify it compiles and commit**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep "src/billing" | head`
Expected: no output.

```bash
# lint only what this task touched — see Global Constraints
git add src/billing/services/
git commit -m "feat(billing): fan limit writes across every workspace on plan and add-on change"
```

---

## Task 9: Non-billing call sites + queue enforcement

**Files:**
- Modify: `src/admin/admin.service.ts`
- Modify: `src/ai/services/ai-token.service.ts`
- Modify: `src/chatbot/chatbot.service.ts`
- Modify: `src/auth/guards/workspace-suspended.guard.ts`
- Modify: `src/workspace/workspace.service.ts`
- Modify: `src/posts/services/post.service.ts`
- Modify: `src/posts/composer/services/composer-scheduling.service.ts`
- Modify: `src/posts/posts.module.ts`, `src/posts/composer/composer.module.ts`
- Modify: `src/drizzle/seeds/backfill-invoices.ts`

**Interfaces:**
- Consumes: `SubscriptionLookupService` (Task 4), `PostQueueService` (Task 5).
- Produces: nothing new.

- [ ] **Step 1: Update the read-only consumers**

- `ai-token.service.ts:102` — `eq(subscriptions.workspaceId, workspaceId)` → resolve the owner, then `eq(subscriptions.userId, ownerId)`.
- `chatbot.service.ts:679` — same change.
- `workspace-suspended.guard.ts:102` — same change. **Keep the existing behaviour that a missing subscription returns `true`** (line 106: `if (!status) return true;`) — a user with no subscription row must not be locked out.
- `backfill-invoices.ts:32` — change the selected column from `subscriptions.workspaceId` to `subscriptions.userId`; this is a maintenance script, so also update any downstream use of the value.

- [ ] **Step 2: Update `admin.service.ts`**

Eleven sites (lines 806, 820, 951, 1323, 1378, 1985, 2008, 2017, 2070, 2090, 2102). The joins `subscriptions → workspace` become `subscriptions → users → workspace`:

```ts
// was: .leftJoin(subscriptions, eq(subscriptions.workspaceId, workspace.id))
.leftJoin(subscriptions, eq(subscriptions.userId, workspace.ownerId))
```

For the two `workspaceId: subscriptions.workspaceId` selections (lines 1985, 2070), select `userId: subscriptions.userId` and join through `workspace.ownerId` to reach workspace rows. Admin revenue figures now count **one subscription per account**, not one per workspace — which is the correction this whole effort exists to make. Verify no admin query double-counts MRR by summing across a user's workspaces.

- [ ] **Step 3: Seed usage on workspace creation**

`workspace.service.ts:50` enforces the workspace limit but never creates a `workspace_usage` row — a latent bug that account scoping makes visible (the second workspace an account creates would have no limits row at all).

**Note the DB handle differs here.** `workspace.service.ts` uses an *injected* `DbType` (`this.db`, via the `DRIZZLE` token — see its constructor), not the global `db` singleton the billing services import. Use `this.db` in this file; using `db` will not compile. It already imports `eq` and `sql` from `drizzle-orm` — add `count` to that import and add `workspaceUsage` to the `src/drizzle/schema` import.

After the workspace insert, add:

```ts
    // Seed this workspace's limits from the owner's subscription. Without this
    // the row is missing and getWorkspaceUsage throws for the new workspace.
    const subscription = await this.lookup.findByUserId(userId);
    const planCode =
      subscription && subscription.status === 'active'
        ? subscription.planCode
        : 'FREE';
    const addons = subscription
      ? await this.lookup.getAddonQuantities(subscription.id)
      : { extraChannels: 0, extraMembers: 0, extraWorkspaces: 0, extraAiTokens: 0 };
    const plan = await this.lookup.getPlanLimits(planCode);

    // A newly created workspace is never the primary one unless it is the
    // account's first, so it starts empty — matching the EXTRA_WORKSPACE rule.
    const [ownedCount] = await this.db
      .select({ n: count() })
      .from(workspace)
      .where(eq(workspace.ownerId, userId));
    const isFirst = Number(ownedCount?.n ?? 0) === 1;

    const limits = resolveWorkspaceLimits(plan, addons, isFirst);

    await this.db.insert(workspaceUsage).values({
      workspaceId: newWorkspace.id,
      channelsLimit: limits.channelsLimit,
      membersLimit: limits.membersLimit,
      aiTokensLimit: limits.aiTokensLimit,
      channelsCount: 0,
      extraChannelsPurchased: 0,
      membersCount: 0,
      extraMembersPurchased: 0,
    });
```

Compute `isFirst` by counting the owner's workspaces after the insert (`=== 1`). Inject `SubscriptionLookupService` into `WorkspaceService` and import `resolveWorkspaceLimits`.

- [ ] **Step 4: Enforce the queue limit on BOTH scheduling paths**

There are two independent paths that insert `status: 'scheduled'`. A check on only one is bypassable by using the other composer.

In `src/posts/services/post.service.ts`, inject `PostQueueService` and add to `createPost`, after `validateChannels` and before the insert:

```ts
    // Queue ceiling is per channel: a post targeting three channels takes one
    // slot on each. Checked before the insert so nothing is written on refusal.
    if (dto.scheduledAt) {
      await this.postQueue.enforceQueueLimit(
        workspaceId,
        channelList.map((channel) => String(channel.id)),
      );
    }
```

Also add the same check to `updatePost` where a draft transitions to `scheduled` (a draft promoted to scheduled must face the same ceiling).

In `src/posts/composer/services/composer-scheduling.service.ts`, inject `PostQueueService` and add the same call before the `insert(posts)` at line 113, using `dto.channels.map((c) => String(c.channelId))`.

Add `BillingModule` to the `imports` of both `posts.module.ts` and `composer.module.ts`.

- [ ] **Step 5: Verify every call site is converted**

Run: `grep -rn "subscriptions.workspaceId" src/`
Expected: **no output**.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: **no errors at all** — the count from Task 3 step 3 is now zero.

- [ ] **Step 6: Run the full test suite and commit**

Run: `npm test`
Expected: all tests pass.

```bash
# npx eslint <files you changed>
git add -A
git commit -m "feat(billing): resolve subscriptions per account across the app, enforce post queue"
```

---

## Task 10: Reseed plans

**Files:**
- Modify: `src/drizzle/seeds/plans.seed.ts`

**Interfaces:**
- Consumes: the `queued_posts_per_channel` column from Task 3.
- Produces: the four tiers and the `EXTRA_WORKSPACE` add-on rows.

- [ ] **Step 1: Update plan data**

In `src/drizzle/seeds/plans.seed.ts`, add `queuedPostsPerChannel` to each plan and update the values to match the spec. **Note MAX's channel count changes from 50 to 25** — confirm with the user before running the seed against production.

| Plan | basePriceCents | channelsPerWorkspace | membersPerWorkspace | maxWorkspaces | queuedPostsPerChannel |
|---|---|---|---|---|---|
| FREE | 0 | 3 | 1 | 1 | 10 |
| BASIC | 500 | 5 | 2 | 1 | -1 |
| PRO | **1500** (was 1000) | 8 | 5 | 3 | -1 |
| MAX | 5000 | **25** (was 50) | 25 | 10 | -1 |

Add `queuedPostsPerChannel: sql\`excluded.queued_posts_per_channel\`` to the `onConflictDoUpdate` set so re-seeding actually updates it.

- [ ] **Step 2: Add EXTRA_WORKSPACE to FREE**

The spec allows a FREE user to buy a workspace. The seed currently defines add-ons only for BASIC, PRO, and MAX. Add a FREE block with `EXTRA_WORKSPACE` at `pricePerUnitCents: 800`. Do NOT add `EXTRA_CHANNEL` or `EXTRA_MEMBER` to FREE — those stay paid-tier upsells.

- [ ] **Step 3: Verify the seed compiles**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep "plans.seed" | head`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
# npx eslint <files you changed>
git add src/drizzle/seeds/plans.seed.ts
git commit -m "feat(billing): reseed plan tiers with queued-post limits"
```

---

## Task 11: Frontend — types, API, and UI

**Repo:** `socialmedia-frontend`. **Create the branch off `origin/main`**, not off the current `feat/layout-redesign-proto`:

```bash
git fetch origin
git checkout -b feat/billing-account-scope origin/main
```

**Files:**
- Modify: `src/features/billing/types/billing.ts`
- Modify: `src/features/billing/api/billing.api.ts`
- Modify: `src/features/billing/components/plans/plan-card.tsx`
- Modify: `src/features/billing/components/plans/plan-comparison-table.tsx`
- Modify: `src/features/billing/components/overview/usage-summary.tsx`
- Modify: `src/features/billing/components/addons/addon-card.tsx`
- Modify: `src/features/billing/hooks/use-workspace-limits.ts`

**Interfaces:**
- Consumes: the backend response shapes from Tasks 6-9.
- Produces: `Plan.queuedPostsPerChannel: number` on the frontend type.

- [ ] **Step 1: Update the types**

In `src/features/billing/types/billing.ts`, add to the `Plan` interface:

```ts
  /** -1 means unlimited scheduling. */
  queuedPostsPerChannel: number
```

- [ ] **Step 2: Add a formatter for the unlimited sentinel**

In `src/features/billing/utils/plan-helpers.ts`, add:

```ts
const UNLIMITED = -1

/**
 * Render a plan limit for display. -1 is a sentinel, not a count — showing it
 * raw would put "-1 posts" in front of a customer.
 */
export function formatLimit(value: number): string {
  return value === UNLIMITED ? 'Unlimited' : String(value)
}
```

- [ ] **Step 3: Surface the queue limit in the plan UI**

In `plan-card.tsx` and `plan-comparison-table.tsx`, add a feature line using `formatLimit(plan.queuedPostsPerChannel)`:
- FREE renders "10 scheduled posts per channel"
- paid tiers render "Unlimited scheduled posts"

Follow the existing feature-line markup in each file — do not introduce new UI primitives. Per the repo's shadcn-only rule, reuse whatever component the neighbouring feature lines already use.

- [ ] **Step 4: Correct the billing copy from workspace to account**

Subscriptions are no longer per workspace, and any copy saying otherwise is now false. Grep for it:

```bash
grep -rn "per workspace\|this workspace's plan\|workspace subscription" src/features/billing/
```

Update each hit to account-level language ("your plan", "your subscription"). Channel and member limits ARE still per workspace — leave that copy alone. The distinction matters: getting it backwards misinforms the customer about what they bought.

- [ ] **Step 5: Explain what EXTRA_WORKSPACE grants**

In `addon-card.tsx`, when `addonType === 'EXTRA_WORKSPACE'`, render a line stating the workspace arrives empty and channels are purchased separately. Without it a customer reasonably expects a bought workspace to carry their plan's channels, and discovers otherwise only after paying.

- [ ] **Step 6: Verify the build**

Run: `npm run build`
Expected: clean (`tsc -b && vite build`).

- [ ] **Step 7: Commit**

```bash
git add src/features/billing/
git commit -m "feat(billing): account-scoped plan copy and queued-post limits"
```

---

## Task 12: Integration verification

Not a code task — the manual pass that catches what unit tests cannot. Run against a local backend with the migration applied to a **development** database.

- [ ] **Step 1: Apply the migration locally**

Apply `drizzle/migrations/0030_billing_account_scope.sql` by hand to the dev database (`psql $DATABASE_URL -f drizzle/migrations/0030_billing_account_scope.sql`). Do NOT run `npm run db:migrate` — journal drift makes it unsafe in this repo.

Then run the seed: `npx ts-node src/drizzle/seeds/plans.seed.ts`

- [ ] **Step 2: Verify the account-scope fix**

The bug this effort exists to fix:

1. Create a user with two workspaces.
2. Give the account a PRO subscription.
3. Confirm `getWorkspaceLimits` returns `maxWorkspaces: 3` — from the single subscription, not by scanning workspaces.
4. Confirm both workspaces have a `workspace_usage` row, that the older one has `channelsLimit: 8`, and the newer has `channelsLimit: 0`.

- [ ] **Step 3: Verify the fan-out**

1. Downgrade the account PRO → BASIC.
2. Confirm **both** workspaces' `workspace_usage` rows updated. If only one changed, a limit-write site was missed — go back to Task 8 and re-run its step 4 grep.

- [ ] **Step 4: Verify the queue limit on both paths**

1. On a FREE account, schedule 10 posts to one channel.
2. Attempt an 11th via `POST /posts/workspaces/:id` — expect 403 with the queue message.
3. Attempt an 11th via the **composer** schedule endpoint — expect the same 403. (A pass here and a failure there means only one path was wired.)
4. Publish one of the 10, then schedule again — expect success, proving the slot frees with no bookkeeping.
5. Confirm a `partially_published` post does not hold a slot.

- [ ] **Step 5: Verify workspace creation seeds usage**

Create a third workspace on a PRO account and confirm a `workspace_usage` row exists immediately, with `channelsLimit: 0`.

- [ ] **Step 6: Verify the guard did not lock anyone out**

Sign in as a user with **no** subscription row and confirm the app is usable — `workspace-suspended.guard.ts` must still return `true` on a missing subscription.

---

## Self-Review Notes

Checked against the spec:

- **Every spec section maps to a task.** Schema changes → Task 3; plan tiers → Task 10; limit resolution → Tasks 1-2; queued posts (incl. the jsonb query and the `partially_published` rule) → Task 5; call-site changes → Tasks 6-9; frontend → Task 11; testing → Tasks 1, 2, 4, 5, 12; risks → Task 9 step 3 (missing usage row) and Task 12 step 6 (guard lockout).

- **Three gaps found in the spec while planning, all now covered:**
  1. **The spec said "`workspace_usage` — no change", which is true of the table but not the writes.** Once one subscription covers many workspaces, five limit-write sites must fan out. Task 2 and Task 8 exist because of this; Task 8 step 4 has a grep that proves no site was missed.
  2. **Two scheduling paths, not one.** `post.service.ts` and `composer-scheduling.service.ts` both insert `status: 'scheduled'`. Task 9 step 4 wires both; Task 12 step 4 tests both.
  3. **`workspace.service.ts` never seeds `workspace_usage`.** Latent today; account scoping makes it reachable. Task 9 step 3.

- **Two spec/code contradictions flagged rather than silently resolved:** MAX channels (seed 50 vs spec 25) and PRO price (seed $10 vs spec $15). Task 10 uses the spec's values and tells the implementer to confirm before seeding production.

- **The bigint/string trap is called out three times** (Global Constraints, Task 5's test, the implementation comment) because a numeric probe fails silently — the limit would simply never fire, with no error to trace.
