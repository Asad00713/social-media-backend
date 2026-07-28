# Team Invitations — Phase 3: Rich Multi-Invite Dialog + Seat Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Replace the single-email invite dialog with a reference-quality multi-recipient dialog (per-recipient role + permission summaries + seat awareness), backed by a seat-gated batch-invite endpoint; and when the workspace is out of member seats, open the existing billing upgrade/add-on flow instead of the invite form.

**Runs on:** existing `feat/team-invitations` branch, both worktrees (`_wt-team-inv`, `_wt-team-inv-fe`). Phases 1–2 already committed.

**Tech:** NestJS + Drizzle (Jest); Vite/React 19/shadcn (vitest). Reuse existing billing components.

## Global Constraints
- No DB migration. `members_count` still increments only on ACCEPT (billing unchanged); the invite SEAT GATE counts accepted + pending.
- Canonical role value `GUEST` (label "Viewer"). Capability map is the source for the dialog's per-role permission copy (`roleCapabilitySummary` from `src/features/team/utils/capabilities.ts`).
- Seat accounting EXCLUDES the owner (matches `members_count` = accepted invitations only).
- shadcn-only UI; Button is @base-ui (`render` not `asChild`). Stage only named files; never `.env`; never `git add -A`.

---

### Task 1: Backend batch-invite endpoint + seat gate

**Files:**
- Modify: `_wt-team-inv/src/workspace-members/workspace-members.service.ts` (add `batchInvite`)
- Modify: `_wt-team-inv/src/workspace-members/workspace-members.controller.ts` (add POST route)
- Create: `_wt-team-inv/src/workspace-members/dto/batch-invite.dto.ts`
- Test: append to `_wt-team-inv/src/workspace-members/workspace-members.service.spec.ts`

**Produces:** `WorkspaceMembersService.batchInvite(workspaceId, invites: {email,role}[], currentUserId): Promise<{ results: {email:string; status:'invited'|'skipped'; reason?:string}[] }>` — throws `ForbiddenException` with code-ish message `SEAT_LIMIT_EXCEEDED` when `reserved + newValidCount > membersLimit`. HTTP `POST /workspace-members/:workspaceId/invitations/batch`.

- [ ] **Step 1 — DTO** `dto/batch-invite.dto.ts`:
```ts
import { Type } from 'class-transformer';
import { IsArray, IsEmail, IsEnum, IsOptional, ValidateNested, ArrayMinSize } from 'class-validator';
import { MemberRole } from './add-member.dto';

export class BatchInviteItemDto {
  @IsEmail()
  email: string;

  @IsEnum(MemberRole)
  @IsOptional()
  role?: MemberRole = MemberRole.MEMBER;
}

export class BatchInviteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BatchInviteItemDto)
  invites: BatchInviteItemDto[];
}
```

- [ ] **Step 2 — failing test** (append to service spec). It asserts the seat gate rejects a batch that exceeds remaining seats. Mock `usageService.getWorkspaceUsage` to return a small limit.
```ts
describe('WorkspaceMembersService.batchInvite seat gate', () => {
  it('rejects the whole batch when it exceeds remaining seats', async () => {
    const db: any = {
      query: {
        workspace: { findFirst: jest.fn().mockResolvedValue({ id: 'w', ownerId: 'owner', name: 'Acme' }) },
        users: { findFirst: jest.fn().mockResolvedValue(undefined) },
        workspaceInvitation: {
          findFirst: jest.fn().mockResolvedValue(undefined),
          findMany: jest.fn().mockResolvedValue([]), // no pending
        },
      },
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: 'i', email: 'x', role: 'MEMBER', token: 't', expiresAt: new Date() }]) }) }),
      // count of accepted members:
      select: () => ({ from: () => ({ where: () => Promise.resolve([{ count: 1 }]) }) }),
    };
    const usageService: any = {
      getWorkspaceUsage: jest.fn().mockResolvedValue({ membersLimit: 2, membersCount: 1, membersAvailable: 1 }),
    };
    const emailService: any = { sendWorkspaceInvitation: jest.fn().mockResolvedValue({ success: true }) };
    const svc = new WorkspaceMembersService(db, usageService, emailService);
    // reserved = membersCount(1) + pending(0) = 1; limit 2 → 1 seat left; batch of 2 → exceeds
    await expect(
      svc.batchInvite('w', [{ email: 'a@x.com', role: 'MEMBER' }, { email: 'b@x.com', role: 'MEMBER' }] as any, 'owner'),
    ).rejects.toThrow(/SEAT_LIMIT_EXCEEDED/);
  });
});
```
Run `cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv" && npx jest src/workspace-members/workspace-members.service.spec.ts -t "seat gate"` → FAIL.

- [ ] **Step 3 — implement `batchInvite`** in the service. Read the existing `inviteMember` for the per-invite validation pattern (owner-check, existing-member, existing-pending, token gen, email send) and REUSE it. Structure:
```ts
async batchInvite(
  workspaceId: string,
  invites: { email: string; role?: 'ADMIN' | 'MEMBER' | 'GUEST' }[],
  currentUserId: string,
) {
  // permission: owner or admin (same check as inviteMember)
  const workspaceData = await this.db.query.workspace.findFirst({ where: eq(workspace.id, workspaceId) });
  if (!workspaceData) throw new NotFoundException('Workspace not found');
  const isOwner = workspaceData.ownerId === currentUserId;
  const isAdmin = await this.isUserAdmin(workspaceId, currentUserId);
  if (!isOwner && !isAdmin) throw new ForbiddenException('Only workspace owner or admins can invite members');

  // seat gate: reserved = accepted members + pending invitations
  const usage = await this.usageService.getWorkspaceUsage(workspaceId);
  const pending = await this.db.query.workspaceInvitation.findMany({
    where: and(eq(workspaceInvitation.workspaceId, workspaceId), eq(workspaceInvitation.status, 'PENDING')),
  });
  const reserved = usage.membersCount + pending.length;
  if (reserved + invites.length > usage.membersLimit) {
    const available = Math.max(0, usage.membersLimit - reserved);
    throw new ForbiddenException(`SEAT_LIMIT_EXCEEDED: ${available} seat(s) left, ${invites.length} requested`);
  }

  // create each invite (reuse inviteMember for validation + email); collect results
  const results: { email: string; status: 'invited' | 'skipped'; reason?: string }[] = [];
  for (const item of invites) {
    try {
      await this.inviteMember(workspaceId, { email: item.email, role: item.role } as any, currentUserId);
      results.push({ email: item.email, status: 'invited' });
    } catch (e: any) {
      results.push({ email: item.email, status: 'skipped', reason: e?.message ?? 'skipped' });
    }
  }
  return { results };
}
```
> Note: `inviteMember` also calls `enforceMemberLimit` (Phase-0 behavior). That is a per-invite guard; the batch seat gate above is the authoritative up-front check. Keeping both is fine — if a race makes `inviteMember` throw, that invite is recorded as `skipped`. Verify `usageService.getWorkspaceUsage` returns `{membersCount, membersLimit}` (it does — `UsageLimits`). If `getWorkspaceUsage` throws 404 (no subscription), CATCH it and treat as `membersLimit = 0` → the gate makes the caller go through the upgrade flow. Match the existing 404-tolerance style used in `inviteMember`'s `enforceMemberLimit` try/catch.

- [ ] **Step 4 — controller route** in `workspace-members.controller.ts`:
```ts
import { BatchInviteDto } from './dto/batch-invite.dto';
// ...
  @Post(':workspaceId/invitations/batch')
  batchInvite(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: BatchInviteDto,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return this.membersService.batchInvite(workspaceId, dto.invites, user.userId);
  }
```
- [ ] **Step 5 — run test (PASS) + typecheck** (`npx tsc --noEmit` — dev server may watch dist; no full build). Commit:
```
cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv"
git add src/workspace-members/workspace-members.service.ts src/workspace-members/workspace-members.controller.ts src/workspace-members/dto/batch-invite.dto.ts src/workspace-members/workspace-members.service.spec.ts
git commit -m "feat(members): seat-gated batch invite endpoint"
```

---

### Task 2: Frontend rich multi-invite dialog

**Files:**
- Modify: `_wt-team-inv-fe/src/features/team/api/team.api.ts` (add `batchInvite`)
- Create: `_wt-team-inv-fe/src/features/team/hooks/use-batch-invite.ts`
- Rewrite: `_wt-team-inv-fe/src/features/team/components/invite-member-dialog.tsx`
- Test: `_wt-team-inv-fe/src/features/team/utils/invite-parse.ts` + `invite-parse.test.ts` (a small pure helper for email chip parsing, unit-tested)

**Interfaces:** `teamApi.batchInvite(workspaceId, invites: {email:string; role:MemberRole}[])`; `useBatchInvite(workspaceId)`.

- [ ] **Step 1 — pure helper + test** `src/features/team/utils/invite-parse.ts`:
```ts
export function parseEmailToken(raw: string): string | null {
  const t = raw.trim().replace(/[,;]$/, '').trim()
  if (!t) return null
  // minimal RFC-ish check; real validation is server-side
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t.toLowerCase() : null
}
```
`invite-parse.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseEmailToken } from './invite-parse'
describe('parseEmailToken', () => {
  it('accepts a valid email and lowercases it', () => {
    expect(parseEmailToken('  Sam@Acme.com , ')).toBe('sam@acme.com')
  })
  it('rejects junk', () => {
    expect(parseEmailToken('not-an-email')).toBeNull()
    expect(parseEmailToken('   ')).toBeNull()
  })
})
```
Run `cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv-fe" && npx vitest run src/features/team/utils/invite-parse.test.ts` → FAIL → implement → PASS.

- [ ] **Step 2 — api + hook.** In `team.api.ts`:
```ts
  batchInvite: (workspaceId: string, invites: { email: string; role: MemberRole }[]) =>
    apiClient.post<{ results: { email: string; status: 'invited' | 'skipped'; reason?: string }[] }>(
      `${BASE}/${workspaceId}/invitations/batch`, { invites },
    ),
```
`use-batch-invite.ts`:
```ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { teamApi, teamKeys } from '../api/team.api'
import type { MemberRole } from '../types/team'

export function useBatchInvite(workspaceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (invites: { email: string; role: MemberRole }[]) => teamApi.batchInvite(workspaceId, invites),
    onSuccess: (res) => {
      const invited = res.results.filter((r) => r.status === 'invited').length
      const skipped = res.results.length - invited
      toast.success(`${invited} invitation${invited === 1 ? '' : 's'} sent${skipped ? `, ${skipped} skipped` : ''}.`)
      qc.invalidateQueries({ queryKey: teamKeys.invitations(workspaceId) })
    },
  })
}
```

- [ ] **Step 3 — rewrite the dialog** `invite-member-dialog.tsx`. Keep the shadcn `Dialog` shell. Replace the single email+role form with:
  - A **chip input**: an `Input` where typing an email and pressing Enter/comma/blur adds a chip (validate with `parseEmailToken`; invalid → shake/inline error, don't add; duplicate → ignore). Chips render as removable `Badge`s (shadcn `Badge` + an X button). Store `recipients: { email: string; role: MemberRole }[]`.
  - A **default-role `Select`** applied to newly added chips, plus a per-chip role `Select` (small) on each chip row so each recipient's role can be changed. Each role option shows `roleLabel(r)` + `roleDescription(r)` (which now derives from `roleCapabilitySummary` — the capability map). Use existing `ASSIGNABLE_ROLES`, `roleLabel`, `roleDescription`, `roleIcon` from `../utils/role`.
  - **Seat awareness:** accept a prop `seatsAvailable: number | null`. Show "N seats left" (muted). If `recipients.length > seatsAvailable` (and seatsAvailable != null), disable Send and show an inline CTA button "Get more seats" that calls a passed `onNeedSeats()` callback (Task 3 wires it to the upgrade dialog).
  - **Send:** `useBatchInvite(workspaceId).mutate(recipients)`, on success close the dialog. Show per-result outcome via the toast (already in the hook). Loading/disabled states throughout.
  - Keep the component a reasonable size; extract a `RecipientChip` subcomponent in the same file if it helps readability.
  - Install any missing shadcn primitive (`badge`) via the shadcn MCP if not already in `src/components/ui/`. (Badge almost certainly exists — verify.)
- [ ] **Step 4 — build** `cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv-fe" && npx vitest run src/features/team/utils/invite-parse.test.ts && npm run build` → PASS.
- [ ] **Step 5 — commit** the changed files (team.api.ts, use-batch-invite.ts, invite-member-dialog.tsx, invite-parse.ts, invite-parse.test.ts):
```
cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv-fe"
git add src/features/team/api/team.api.ts src/features/team/hooks/use-batch-invite.ts src/features/team/components/invite-member-dialog.tsx src/features/team/utils/invite-parse.ts src/features/team/utils/invite-parse.test.ts
git commit -m "feat(team): rich multi-recipient invite dialog with per-role + seat awareness"
```

---

### Task 3: Seat-limit → upgrade/add-on gating at the invite entry point

**Files:**
- Create: `_wt-team-inv-fe/src/features/team/components/seat-upgrade-dialog.tsx`
- Modify: `_wt-team-inv-fe/src/features/team/components/team-settings-view.tsx` (wire the "Invite people" button through a seat check)

**Behavior:** when the user clicks "Invite people":
- read workspace usage via the existing `useWorkspaceUsage(workspaceId)` billing hook → `membersAvailable`.
- `membersAvailable > 0` → open the invite dialog (Task 2), passing `seatsAvailable={membersAvailable}` and `onNeedSeats={() => openSeatUpgrade()}`.
- `membersAvailable <= 0` (or usage unavailable / free plan with 0 invitable seats) → open the **SeatUpgradeDialog** instead.

- [ ] **Step 1 — read the billing feature to wire reuse (no guessing):**
  - `src/features/billing/hooks/use-workspace-usage.ts` — its export + return shape (`membersAvailable`, `membersLimit`, `membersCount`).
  - `src/features/billing/hooks/use-purchase-addon.ts` — signature (`{ addonType, quantity }`, `AddonType` includes `'EXTRA_MEMBER'`).
  - `src/features/billing/components/addons/purchase-addon-dialog.tsx` and `src/features/billing/components/plans/*` (plan cards + `billing-cycle-toggle`) — to compose or link to.

- [ ] **Step 2 — build `seat-upgrade-dialog.tsx`:** a shadcn `Dialog` presenting BOTH options professionally (reusing existing billing components, NOT hand-rolled UI):
  - **Primary — buy extra seats:** a quantity stepper + "Add N seats" that calls `usePurchaseAddon().mutate({ addonType: 'EXTRA_MEMBER', quantity })`. On success, invalidate the workspace-usage query and close (the invite dialog becomes reachable). If `purchase-addon-dialog` already encapsulates this, RENDER/COMPOSE it (pass `addonType='EXTRA_MEMBER'`) rather than duplicating.
  - **Secondary — upgrade plan:** a link/button to the billing plans route (reuse `wsPath(workspaceId, 'settings/billing')` or the existing plans navigation) or embed the plan cards. Keep it a clear secondary action.
  - Title: "You're out of member seats". Copy explains current usage (`membersCount`/`membersLimit`).
  - Loading/disabled/error states.
- [ ] **Step 3 — wire the entry point** in `team-settings-view.tsx`: replace the direct `setInviteOpen(true)` with a handler that reads `useWorkspaceUsage(workspaceId)` and branches to invite-dialog vs seat-upgrade-dialog as above. Keep the empty-state CTA behavior consistent. Pass `seatsAvailable` + `onNeedSeats` into `<InviteMemberDialog />`.
- [ ] **Step 4 — build** `cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv-fe" && npm run build` → PASS.
- [ ] **Step 5 — commit:**
```
cd "d:/My Documents/MyProjects/FullStackProjects/_wt-team-inv-fe"
git add src/features/team/components/seat-upgrade-dialog.tsx src/features/team/components/team-settings-view.tsx
git commit -m "feat(team): seat-limit gate opens upgrade/add-on flow at invite entry"
```

---

## Self-Review Notes
- **Spec coverage (Phase 3 = spec §5, §7, §8):** batch endpoint + seat gate (T1), rich multi-invite dialog with per-role + permission-summary + seat awareness (T2), seat-full → both add-on + upgrade via existing billing UI (T3).
- **No placeholders in the critical path** (backend batch, DTO, chip parser). The billing-reuse UI (T3) intentionally instructs the implementer to READ + compose existing, already-built billing components rather than reproduce their props here — those components are inspectable and stable.
- **Type consistency:** role value `GUEST` everywhere; `MemberRole` from `types/team`; batch result shape identical BE↔FE; `roleCan`/summaries from `utils/capabilities` (Phase 2).
- **Verify during execution:** `useWorkspaceUsage` export/shape; whether `purchase-addon-dialog` is directly composable with `addonType='EXTRA_MEMBER'`; shadcn `badge` present; the current `team-settings-view` invite-button wiring.
