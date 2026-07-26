# Team Invitations — Phase 1: Invite Loop (email + accept + signup-first) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the invitation loop end-to-end — an invited email receives a real invite email, lands on an accept page, signs up if needed, and auto-joins the workspace.

**Architecture:** Backend already creates invitation rows and has accept/reject endpoints; this phase wires the missing email send, adds a public preview endpoint, and builds the frontend accept page + signup-first auto-accept handoff via the existing localStorage continuity pattern.

**Tech Stack:** NestJS + Drizzle + Resend (backend, Jest); Vite + React 19 + shadcn/ui + TanStack Query + React Router + vitest (frontend).

**Spec:** `docs/superpowers/specs/2026-07-26-team-members-invitations-design.md` (§3, §4, §9 — this phase). Phases 2 (roles/guards) and 3 (rich multi-invite dialog + seat→billing gating) are separate plans.

## Global Constraints

- **No DB schema migration**; reuse existing tables/enums. Never run `db:generate`/`db:push`.
- **shadcn-only** UI; theme tokens only; icons from `lucide-react` or existing `react-iconly` usage.
- **Auth is opt-in per controller** — there is no global `APP_GUARD`. A route is public simply by omitting `@UseGuards(JwtAuthGuard)`. The existing `WorkspaceMembersController` applies `JwtAuthGuard` at the class level, so the public preview route MUST live in a separate controller.
- Preview endpoint returns only safe fields — never the token, never member lists.
- Accept links are built from `EmailService.frontendUrl` (`FRONTEND_URL` env), path `/invite/accept?token=<token>`.
- Backend staging discipline: stage ONLY the files each task names (`git add <paths>`); never `git add -A`/`.`. Do not stage `.env`.
- Frontend `.env` is tracked and dirty — never stage it.

---

### Task 1: `EmailService.sendWorkspaceInvitation`

**Files:**
- Modify: `socialmedia-workspace/src/email/email.service.ts` (add method near `sendPasswordResetEmail`, ~line 720)
- Test: `socialmedia-workspace/src/email/email.service.spec.ts` (create)

**Interfaces:**
- Produces: `EmailService.sendWorkspaceInvitation(email: string, data: { workspaceName: string; inviterName?: string; role: 'ADMIN'|'MEMBER'|'GUEST'; token: string; expiresAt: Date }): Promise<EmailResult>`

- [ ] **Step 1: Write the failing test**

```ts
// socialmedia-workspace/src/email/email.service.spec.ts
import { EmailService } from './email.service';
import { ConfigService } from '@nestjs/config';

function makeService(): EmailService {
  // No RESEND_API_KEY → sendEmail logs instead of sending, returns success.
  const config = {
    get: (key: string, def?: string) =>
      key === 'FRONTEND_URL' ? 'https://app.schedura.ai' : def,
  } as unknown as ConfigService;
  return new EmailService(config);
}

describe('EmailService.sendWorkspaceInvitation', () => {
  it('builds the accept URL from FRONTEND_URL and sends', async () => {
    const service = makeService();
    const spy = jest.spyOn(service, 'sendEmail');
    const res = await service.sendWorkspaceInvitation('teammate@acme.com', {
      workspaceName: 'Acme',
      inviterName: 'Sam',
      role: 'MEMBER',
      token: 'tok123',
      expiresAt: new Date('2026-08-02T00:00:00Z'),
    });
    expect(res.success).toBe(true);
    const arg = spy.mock.calls[0][0];
    expect(arg.to).toBe('teammate@acme.com');
    expect(arg.html).toContain('https://app.schedura.ai/invite/accept?token=tok123');
    expect(arg.text).toContain('https://app.schedura.ai/invite/accept?token=tok123');
    expect(arg.subject).toContain('Acme');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd socialmedia-workspace && npx jest src/email/email.service.spec.ts`
Expected: FAIL — `sendWorkspaceInvitation is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `EmailService` (mirror the style of `sendPasswordResetEmail`):

```ts
  /**
   * Send a workspace invitation email with an accept link.
   */
  async sendWorkspaceInvitation(
    email: string,
    data: {
      workspaceName: string;
      inviterName?: string;
      role: 'ADMIN' | 'MEMBER' | 'GUEST';
      token: string;
      expiresAt: Date;
    },
  ): Promise<EmailResult> {
    const acceptUrl = `${this.frontendUrl}/invite/accept?token=${data.token}`;
    const inviter = data.inviterName ? `${data.inviterName} invited you` : 'You have been invited';
    const roleLabel = data.role.charAt(0) + data.role.slice(1).toLowerCase();
    const expires = data.expiresAt.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Workspace Invitation</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">You're invited to ${data.workspaceName}</h1>
  </div>
  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none;">
    <p style="font-size: 16px; margin-top: 0;">Hi there,</p>
    <p>${inviter} to join <strong>${data.workspaceName}</strong> as a <strong>${roleLabel}</strong>.</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="${acceptUrl}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 15px 30px; border-radius: 8px; font-weight: bold; font-size: 16px;">Accept invitation</a>
    </div>
    <p style="color: #6b7280; font-size: 14px;">This invitation expires on ${expires}.</p>
    <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
      <p style="color: #9ca3af; font-size: 12px; margin: 0;">If the button doesn't work, copy and paste this link:<br>
        <a href="${acceptUrl}" style="color: #667eea; word-break: break-all;">${acceptUrl}</a>
      </p>
    </div>
  </div>
  <div style="text-align: center; padding: 20px; color: #9ca3af; font-size: 12px;"><p>This email was sent by Schedura.</p></div>
</body>
</html>`.trim();

    const text = `
${inviter} to join ${data.workspaceName} as a ${roleLabel}.

Accept your invitation:
${acceptUrl}

This invitation expires on ${expires}.

---
This email was sent by Schedura.`.trim();

    return this.sendEmail({
      to: email,
      subject: `You're invited to join ${data.workspaceName} on Schedura`,
      html,
      text,
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd socialmedia-workspace && npx jest src/email/email.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add socialmedia-workspace/src/email/email.service.ts socialmedia-workspace/src/email/email.service.spec.ts
git commit -m "feat(email): add workspace invitation email"
```

---

### Task 2: Wire the invitation email into `inviteMember`

**Files:**
- Modify: `socialmedia-workspace/src/workspace-members/workspace-members.service.ts` (constructor + `inviteMember`, replace the `// TODO: Send email` block at ~line 134)
- Modify: `socialmedia-workspace/src/workspace-members/workspace-members.module.ts` (import `EmailModule`)
- Test: `socialmedia-workspace/src/workspace-members/workspace-members.service.spec.ts` (create)

**Interfaces:**
- Consumes: `EmailService.sendWorkspaceInvitation` (Task 1).
- Produces: `inviteMember` now sends the email after creating the invitation row (unchanged return shape).

- [ ] **Step 1: Write the failing test**

```ts
// socialmedia-workspace/src/workspace-members/workspace-members.service.spec.ts
import { WorkspaceMembersService } from './workspace-members.service';

describe('WorkspaceMembersService.inviteMember email', () => {
  it('sends an invitation email after creating the invitation', async () => {
    const invitationRow = {
      id: 'inv1', email: 'new@acme.com', role: 'MEMBER',
      token: 'tok123', expiresAt: new Date('2026-08-02T00:00:00Z'),
    };
    // Minimal drizzle-query mock covering the calls inviteMember makes.
    const db: any = {
      query: {
        workspace: { findFirst: jest.fn().mockResolvedValue({ id: 'ws1', ownerId: 'owner1' }) },
        users: { findFirst: jest.fn().mockResolvedValue(undefined) }, // owner lookup + invitee lookup
        workspaceInvitation: { findFirst: jest.fn().mockResolvedValue(undefined) }, // no existing member/invite
      },
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([invitationRow]) }) }),
    };
    const usageService: any = { enforceMemberLimit: jest.fn().mockResolvedValue(undefined) };
    const emailService: any = { sendWorkspaceInvitation: jest.fn().mockResolvedValue({ success: true }) };

    const service = new WorkspaceMembersService(db, usageService, emailService);
    await service.inviteMember('ws1', { email: 'new@acme.com', role: 'MEMBER' } as any, 'admin1');

    expect(emailService.sendWorkspaceInvitation).toHaveBeenCalledWith(
      'new@acme.com',
      expect.objectContaining({ token: 'tok123', role: 'MEMBER' }),
    );
  });
});
```

> Note: `inviteMember` calls `isUserAdmin` (queries `workspaceInvitation.findFirst`) when the caller is not the owner. Here the caller `admin1` ≠ `ownerId 'owner1'`, so `isUserAdmin` runs and returns falsy → ForbiddenException. To keep the test focused on email wiring, pass the OWNER as the caller: use `'owner1'` as `currentUserId`. Update the call to `service.inviteMember('ws1', {...}, 'owner1')`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd socialmedia-workspace && npx jest src/workspace-members/workspace-members.service.spec.ts`
Expected: FAIL — constructor arity (service takes 2 args) / `sendWorkspaceInvitation` never called.

- [ ] **Step 3: Write minimal implementation**

In `workspace-members.service.ts`, add the EmailService import and constructor param:

```ts
import { EmailService } from 'src/email/email.service';
// ...
  constructor(
    @Inject(DRIZZLE) private db: DbType,
    private usageService: UsageService,
    private emailService: EmailService,
  ) {}
```

Replace the `// TODO: Send email ...` comment block (~line 134) with:

```ts
    // Send the invitation email (best-effort — the row exists regardless; resend covers retries)
    const workspaceName = workspaceData.name ?? 'your workspace';
    const inviterUser = await this.db.query.users.findFirst({
      where: eq(users.id, currentUserId),
      columns: { name: true },
    });
    try {
      await this.emailService.sendWorkspaceInvitation(inviteMemberDto.email, {
        workspaceName,
        inviterName: inviterUser?.name ?? undefined,
        role: invitation.role as 'ADMIN' | 'MEMBER' | 'GUEST',
        token: invitation.token,
        expiresAt: invitation.expiresAt,
      });
    } catch (err) {
      console.error('Failed to send invitation email:', err);
    }
```

> Verify `workspace.schema` has a `name` column; if the property differs, use the actual column. The test mock returns `{ id, ownerId }` only, so also mock `name` there or assert the fallback.

In `workspace-members.module.ts` add `EmailModule` to imports:

```ts
import { EmailModule } from 'src/email/email.module';
// ...
  imports: [PassportModule, AuthModule, JwtModule.register({}), BillingModule, EmailModule],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd socialmedia-workspace && npx jest src/workspace-members/workspace-members.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Verify the app compiles**

Run: `cd socialmedia-workspace && npm run build`
Expected: build succeeds (module wiring resolves EmailService).

- [ ] **Step 6: Commit**

```bash
git add socialmedia-workspace/src/workspace-members/workspace-members.service.ts socialmedia-workspace/src/workspace-members/workspace-members.service.spec.ts socialmedia-workspace/src/workspace-members/workspace-members.module.ts
git commit -m "feat(members): send invitation email on invite"
```

---

### Task 3: Public preview endpoint

**Files:**
- Modify: `socialmedia-workspace/src/workspace-members/workspace-members.service.ts` (add `previewInvitation`)
- Create: `socialmedia-workspace/src/workspace-members/public-invitations.controller.ts`
- Modify: `socialmedia-workspace/src/workspace-members/workspace-members.module.ts` (register controller)
- Test: `socialmedia-workspace/src/workspace-members/workspace-members.service.spec.ts` (append)

**Interfaces:**
- Produces: `WorkspaceMembersService.previewInvitation(token: string): Promise<{ workspaceName: string; inviterName: string | null; invitedEmail: string; role: 'ADMIN'|'MEMBER'|'GUEST'; status: 'PENDING'|'ACCEPTED'|'REJECTED'|'EXPIRED'; expired: boolean }>` — throws `NotFoundException` if no invitation.
- Produces HTTP: `GET /workspace-members/invitations/preview?token=` (public, no auth).

- [ ] **Step 1: Write the failing test**

```ts
// append to workspace-members.service.spec.ts
describe('WorkspaceMembersService.previewInvitation', () => {
  it('returns safe fields and an expired flag', async () => {
    const past = new Date('2000-01-01T00:00:00Z');
    const db: any = {
      query: {
        workspaceInvitation: {
          findFirst: jest.fn().mockResolvedValue({
            email: 'new@acme.com', role: 'MEMBER', status: 'PENDING', expiresAt: past,
            workspace: { name: 'Acme' }, inviter: { name: 'Sam' },
          }),
        },
      },
    };
    const service = new WorkspaceMembersService(db, {} as any, {} as any);
    const res = await service.previewInvitation('tok123');
    expect(res).toEqual({
      workspaceName: 'Acme', inviterName: 'Sam', invitedEmail: 'new@acme.com',
      role: 'MEMBER', status: 'PENDING', expired: true,
    });
    expect((res as any).token).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd socialmedia-workspace && npx jest src/workspace-members/workspace-members.service.spec.ts -t previewInvitation`
Expected: FAIL — `previewInvitation is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `WorkspaceMembersService`:

```ts
  // Public: minimal invitation info by token (no auth, no sensitive fields)
  async previewInvitation(token: string) {
    const invitation = await this.db.query.workspaceInvitation.findFirst({
      where: eq(workspaceInvitation.token, token),
      with: {
        workspace: { columns: { name: true } },
        inviter: { columns: { name: true } },
      },
    });
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }
    return {
      workspaceName: invitation.workspace?.name ?? 'a workspace',
      inviterName: invitation.inviter?.name ?? null,
      invitedEmail: invitation.email,
      role: invitation.role as 'ADMIN' | 'MEMBER' | 'GUEST',
      status: invitation.status as 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED',
      expired: new Date() > invitation.expiresAt,
    };
  }
```

Create `public-invitations.controller.ts` (NO class guard — public):

```ts
import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { WorkspaceMembersService } from './workspace-members.service';

/**
 * Public (unauthenticated) invitation lookup. Lives in its own controller
 * because WorkspaceMembersController applies JwtAuthGuard at the class level.
 */
@Controller('workspace-members')
export class PublicInvitationsController {
  constructor(private readonly membersService: WorkspaceMembersService) {}

  @Get('invitations/preview')
  preview(@Query('token') token: string) {
    if (!token) throw new BadRequestException('token is required');
    return this.membersService.previewInvitation(token);
  }
}
```

Register it in `workspace-members.module.ts`:

```ts
import { PublicInvitationsController } from './public-invitations.controller';
// ...
  controllers: [WorkspaceMembersController, PublicInvitationsController],
```

- [ ] **Step 4: Run test + build**

Run: `cd socialmedia-workspace && npx jest src/workspace-members/workspace-members.service.spec.ts && npm run build`
Expected: PASS + build succeeds.

- [ ] **Step 5: Manually verify the route is public**

Run the dev server, then: `curl "http://localhost:3000/workspace-members/invitations/preview?token=nonexistent"`
Expected: `404` with "Invitation not found" (NOT `401 Unauthorized` — proves the route is unguarded).

- [ ] **Step 6: Commit**

```bash
git add socialmedia-workspace/src/workspace-members/workspace-members.service.ts socialmedia-workspace/src/workspace-members/public-invitations.controller.ts socialmedia-workspace/src/workspace-members/workspace-members.module.ts socialmedia-workspace/src/workspace-members/workspace-members.service.spec.ts
git commit -m "feat(members): public invitation preview endpoint"
```

---

### Task 4: Frontend API wrappers + types + hooks

**Files:**
- Modify: `socialmedia-frontend/src/features/team/api/team.api.ts`
- Modify: `socialmedia-frontend/src/features/team/types/team.ts` (add `InvitationPreview`)
- Create: `socialmedia-frontend/src/features/team/hooks/use-invitation-preview.ts`
- Create: `socialmedia-frontend/src/features/team/hooks/use-accept-invitation.ts`
- Create: `socialmedia-frontend/src/features/team/hooks/use-reject-invitation.ts`
- Test: `socialmedia-frontend/src/features/team/api/team.api.test.ts` (create)

**Interfaces:**
- Consumes: backend preview/accept/reject endpoints.
- Produces: `teamApi.previewInvitation(token)`, `teamApi.acceptInvitation(token)`, `teamApi.rejectInvitation(token)`; `InvitationPreview` type; `useInvitationPreview(token)`, `useAcceptInvitation()`, `useRejectInvitation()`.

- [ ] **Step 1: Write the failing test**

```ts
// socialmedia-frontend/src/features/team/api/team.api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { teamApi } from './team.api'
import { apiClient } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({}) },
}))

beforeEach(() => vi.clearAllMocks())

describe('teamApi invitation wrappers', () => {
  it('previewInvitation hits the public preview route with the token', () => {
    teamApi.previewInvitation('tok123')
    expect(apiClient.get).toHaveBeenCalledWith('/workspace-members/invitations/preview?token=tok123')
  })
  it('acceptInvitation posts to the accept route with the token', () => {
    teamApi.acceptInvitation('tok123')
    expect(apiClient.post).toHaveBeenCalledWith('/workspace-members/invitations/accept?token=tok123', {})
  })
  it('rejectInvitation posts to the reject route with the token', () => {
    teamApi.rejectInvitation('tok123')
    expect(apiClient.post).toHaveBeenCalledWith('/workspace-members/invitations/reject?token=tok123', {})
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd socialmedia-frontend && npx vitest run src/features/team/api/team.api.test.ts`
Expected: FAIL — `previewInvitation is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `types/team.ts`:

```ts
export interface InvitationPreview {
  workspaceName: string
  inviterName: string | null
  invitedEmail: string
  role: MemberRole
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED'
  expired: boolean
}
```

Add to `teamApi` in `team.api.ts` (token is URL-encoded):

```ts
  previewInvitation: (token: string) =>
    apiClient.get<InvitationPreview>(
      `${BASE}/invitations/preview?token=${encodeURIComponent(token)}`,
    ),

  acceptInvitation: (token: string) =>
    apiClient.post<unknown>(
      `${BASE}/invitations/accept?token=${encodeURIComponent(token)}`,
      {},
    ),

  rejectInvitation: (token: string) =>
    apiClient.post<{ message: string }>(
      `${BASE}/invitations/reject?token=${encodeURIComponent(token)}`,
      {},
    ),
```

Import `InvitationPreview` in `team.api.ts`.

> The test asserts the un-encoded form because `tok123` has no special chars; `encodeURIComponent('tok123') === 'tok123'`.

Create `use-invitation-preview.ts`:

```ts
import { useQuery } from '@tanstack/react-query'
import { teamApi } from '../api/team.api'

export function useInvitationPreview(token: string | null) {
  return useQuery({
    queryKey: ['invitation-preview', token],
    queryFn: () => teamApi.previewInvitation(token as string),
    enabled: !!token,
    retry: false,
  })
}
```

Create `use-accept-invitation.ts`:

```ts
import { useMutation } from '@tanstack/react-query'
import { teamApi } from '../api/team.api'

export function useAcceptInvitation() {
  return useMutation({ mutationFn: (token: string) => teamApi.acceptInvitation(token) })
}
```

Create `use-reject-invitation.ts`:

```ts
import { useMutation } from '@tanstack/react-query'
import { teamApi } from '../api/team.api'

export function useRejectInvitation() {
  return useMutation({ mutationFn: (token: string) => teamApi.rejectInvitation(token) })
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `cd socialmedia-frontend && npx vitest run src/features/team/api/team.api.test.ts && npm run build`
Expected: PASS + build succeeds.

- [ ] **Step 5: Commit**

```bash
git add socialmedia-frontend/src/features/team/api/team.api.ts socialmedia-frontend/src/features/team/types/team.ts socialmedia-frontend/src/features/team/hooks/use-invitation-preview.ts socialmedia-frontend/src/features/team/hooks/use-accept-invitation.ts socialmedia-frontend/src/features/team/hooks/use-reject-invitation.ts socialmedia-frontend/src/features/team/api/team.api.test.ts
git commit -m "feat(team): invitation preview/accept/reject api + hooks"
```

---

### Task 5: Pending-invite storage helpers

**Files:**
- Modify: `socialmedia-frontend/src/lib/auth-storage.ts`
- Test: `socialmedia-frontend/src/lib/auth-storage.test.ts` (create)

**Interfaces:**
- Produces: `rememberPendingInvite(token: string)`, `getPendingInvite(): string | null`, `forgetPendingInvite()`.

- [ ] **Step 1: Write the failing test**

```ts
// socialmedia-frontend/src/lib/auth-storage.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { rememberPendingInvite, getPendingInvite, forgetPendingInvite } from './auth-storage'

beforeEach(() => localStorage.clear())

describe('pending invite storage', () => {
  it('remembers, reads, and forgets a token', () => {
    expect(getPendingInvite()).toBeNull()
    rememberPendingInvite('tok123')
    expect(getPendingInvite()).toBe('tok123')
    forgetPendingInvite()
    expect(getPendingInvite()).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd socialmedia-frontend && npx vitest run src/lib/auth-storage.test.ts`
Expected: FAIL — imports undefined.

- [ ] **Step 3: Write minimal implementation**

In `auth-storage.ts`, add `pendingInvite: 'auth.pendingInvite'` to `KEYS`, and:

```ts
// ──────────────────────────── pending invite ────────────────────────────

export function rememberPendingInvite(token: string): void {
  safeSet(KEYS.pendingInvite, token)
}

export function getPendingInvite(): string | null {
  return safeGet(KEYS.pendingInvite)
}

export function forgetPendingInvite(): void {
  safeRemove(KEYS.pendingInvite)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd socialmedia-frontend && npx vitest run src/lib/auth-storage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add socialmedia-frontend/src/lib/auth-storage.ts socialmedia-frontend/src/lib/auth-storage.test.ts
git commit -m "feat(auth): pending-invite localStorage helpers"
```

---

### Task 6: Accept-state resolver (pure logic)

**Files:**
- Create: `socialmedia-frontend/src/features/team/utils/accept-state.ts`
- Test: `socialmedia-frontend/src/features/team/utils/accept-state.test.ts` (create)

**Interfaces:**
- Consumes: `InvitationPreview` (Task 4).
- Produces: `resolveAcceptState(input): AcceptState` — a discriminated union driving the accept page.

```ts
type AcceptState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'expired' }
  | { kind: 'already'; status: 'ACCEPTED' | 'REJECTED' }
  | { kind: 'needs-auth'; email: string }
  | { kind: 'needs-verify' }
  | { kind: 'mismatch'; invitedEmail: string; currentEmail: string }
  | { kind: 'ready'; token: string }
```

- [ ] **Step 1: Write the failing test**

```ts
// socialmedia-frontend/src/features/team/utils/accept-state.test.ts
import { describe, it, expect } from 'vitest'
import { resolveAcceptState } from './accept-state'
import type { InvitationPreview } from '../types/team'

const preview = (over: Partial<InvitationPreview> = {}): InvitationPreview => ({
  workspaceName: 'Acme', inviterName: 'Sam', invitedEmail: 'new@acme.com',
  role: 'MEMBER', status: 'PENDING', expired: false, ...over,
})

describe('resolveAcceptState', () => {
  it('loading while preview pending', () => {
    expect(resolveAcceptState({ token: 't', isLoading: true, error: null, preview: undefined, auth: { isAuthenticated: false, isVerified: false, email: null } }).kind).toBe('loading')
  })
  it('error when preview errored', () => {
    expect(resolveAcceptState({ token: 't', isLoading: false, error: new Error('x'), preview: undefined, auth: { isAuthenticated: false, isVerified: false, email: null } }).kind).toBe('error')
  })
  it('expired flag wins', () => {
    expect(resolveAcceptState({ token: 't', isLoading: false, error: null, preview: preview({ expired: true }), auth: { isAuthenticated: false, isVerified: false, email: null } }).kind).toBe('expired')
  })
  it('already accepted', () => {
    expect(resolveAcceptState({ token: 't', isLoading: false, error: null, preview: preview({ status: 'ACCEPTED' }), auth: { isAuthenticated: false, isVerified: false, email: null } }).kind).toBe('already')
  })
  it('needs-auth when logged out', () => {
    const s = resolveAcceptState({ token: 't', isLoading: false, error: null, preview: preview(), auth: { isAuthenticated: false, isVerified: false, email: null } })
    expect(s).toEqual({ kind: 'needs-auth', email: 'new@acme.com' })
  })
  it('needs-verify when authed but unverified', () => {
    expect(resolveAcceptState({ token: 't', isLoading: false, error: null, preview: preview(), auth: { isAuthenticated: true, isVerified: false, email: 'new@acme.com' } }).kind).toBe('needs-verify')
  })
  it('mismatch when emails differ', () => {
    const s = resolveAcceptState({ token: 't', isLoading: false, error: null, preview: preview(), auth: { isAuthenticated: true, isVerified: true, email: 'other@acme.com' } })
    expect(s.kind).toBe('mismatch')
  })
  it('ready when authed, verified, matching', () => {
    const s = resolveAcceptState({ token: 't', isLoading: false, error: null, preview: preview(), auth: { isAuthenticated: true, isVerified: true, email: 'new@acme.com' } })
    expect(s).toEqual({ kind: 'ready', token: 't' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd socialmedia-frontend && npx vitest run src/features/team/utils/accept-state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// socialmedia-frontend/src/features/team/utils/accept-state.ts
import type { InvitationPreview } from '../types/team'

export type AcceptState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'expired' }
  | { kind: 'already'; status: 'ACCEPTED' | 'REJECTED' }
  | { kind: 'needs-auth'; email: string }
  | { kind: 'needs-verify' }
  | { kind: 'mismatch'; invitedEmail: string; currentEmail: string }
  | { kind: 'ready'; token: string }

interface Input {
  token: string
  isLoading: boolean
  error: unknown
  preview: InvitationPreview | undefined
  auth: { isAuthenticated: boolean; isVerified: boolean; email: string | null }
}

export function resolveAcceptState(input: Input): AcceptState {
  const { token, isLoading, error, preview, auth } = input
  if (isLoading) return { kind: 'loading' }
  if (error || !preview) {
    return { kind: 'error', message: 'This invitation link is invalid or could not be loaded.' }
  }
  if (preview.expired || preview.status === 'EXPIRED') return { kind: 'expired' }
  if (preview.status === 'ACCEPTED' || preview.status === 'REJECTED') {
    return { kind: 'already', status: preview.status }
  }
  if (!auth.isAuthenticated) return { kind: 'needs-auth', email: preview.invitedEmail }
  if (!auth.isVerified) return { kind: 'needs-verify' }
  if ((auth.email ?? '').toLowerCase() !== preview.invitedEmail.toLowerCase()) {
    return { kind: 'mismatch', invitedEmail: preview.invitedEmail, currentEmail: auth.email ?? '' }
  }
  return { kind: 'ready', token }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd socialmedia-frontend && npx vitest run src/features/team/utils/accept-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add socialmedia-frontend/src/features/team/utils/accept-state.ts socialmedia-frontend/src/features/team/utils/accept-state.test.ts
git commit -m "feat(team): accept-state resolver"
```

---

### Task 7: Accept page + route + auto-accept wiring

**Files:**
- Create: `socialmedia-frontend/src/features/team/components/accept-invitation-view.tsx`
- Create: `socialmedia-frontend/src/pages/invite/accept.tsx` (thin)
- Modify: `socialmedia-frontend/src/router.tsx` (add public route `/invite/accept`)
- Modify: `socialmedia-frontend/src/pages/index-redirect.tsx` (pending-invite short-circuit)
- Modify: `socialmedia-frontend/src/features/auth/components/login-form.tsx` and `signup-form.tsx` (prefill email from `?email=`)

**Interfaces:**
- Consumes: `useInvitationPreview`, `useAcceptInvitation`, `useRejectInvitation` (Task 4), `resolveAcceptState` (Task 6), pending-invite storage (Task 5), `useAuth()`.

- [ ] **Step 1: Add the pending-invite short-circuit to IndexRedirect**

In `index-redirect.tsx`, import `getPendingInvite` from `@/lib/auth-storage`, and after the `!isVerified` guard, before `!hasWorkspace`:

```ts
  // An invited user (mid signup-first flow) is routed to accept the invite and
  // join the inviter's workspace — not pushed through create-workspace onboarding.
  const pendingInvite = getPendingInvite()
  if (pendingInvite) {
    return <Navigate to={`/invite/accept?token=${encodeURIComponent(pendingInvite)}`} replace />
  }
```

- [ ] **Step 2: Prefill email on login/signup from `?email=`**

In `login-form.tsx` and `signup-form.tsx`, read the query param and seed the form default. Example for `login-form.tsx`:

```ts
import { useSearchParams } from 'react-router'
// inside component, before useForm:
const [params] = useSearchParams()
const prefillEmail = params.get('email') ?? ''
const form = useForm<LoginFormValues>({
  resolver: zodResolver(loginSchema),
  defaultValues: { ...DEFAULTS, email: prefillEmail },
  mode: 'onBlur',
})
```

Apply the equivalent change to `signup-form.tsx` (seed its email default from the same param). Keep existing remembered-email behavior intact.

- [ ] **Step 3: Build the accept view**

```tsx
// socialmedia-frontend/src/features/team/components/accept-invitation-view.tsx
import { useEffect } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/contexts/auth-context'
import { wsHome } from '@/lib/workspace-path'
import {
  rememberPendingInvite,
  forgetPendingInvite,
} from '@/lib/auth-storage'
import { useInvitationPreview } from '../hooks/use-invitation-preview'
import { useAcceptInvitation } from '../hooks/use-accept-invitation'
import { useRejectInvitation } from '../hooks/use-reject-invitation'
import { resolveAcceptState } from '../utils/accept-state'

export function AcceptInvitationView() {
  const [params] = useSearchParams()
  const token = params.get('token')
  const navigate = useNavigate()
  const { isAuthenticated, isVerified, user, workspaces, lastAccessedWorkspace } = useAuth()
  const { data: preview, isLoading, error } = useInvitationPreview(token)
  const accept = useAcceptInvitation()
  const reject = useRejectInvitation()

  const state = resolveAcceptState({
    token: token ?? '',
    isLoading,
    error,
    preview,
    auth: { isAuthenticated, isVerified, email: user?.email ?? null },
  })

  // Auto-accept as soon as we're ready.
  useEffect(() => {
    if (state.kind === 'ready' && !accept.isPending && !accept.isSuccess) {
      accept.mutate(state.token, {
        onSuccess: () => {
          forgetPendingInvite()
          const wsId = lastAccessedWorkspace?.id ?? workspaces[0]?.id ?? null
          navigate(wsId ? wsHome(wsId) : '/', { replace: true })
        },
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind])

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-md flex-col justify-center px-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle>
            {state.kind === 'error' ? 'Invitation problem' : "You're invited"}
          </CardTitle>
          <CardDescription>
            {preview
              ? `${preview.inviterName ?? 'Someone'} invited you to ${preview.workspaceName} as ${preview.role.toLowerCase()}.`
              : 'Loading your invitation…'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {(state.kind === 'loading' || state.kind === 'ready') && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {state.kind === 'ready' ? 'Joining workspace…' : 'Loading…'}
            </div>
          )}

          {state.kind === 'error' && (
            <p className="text-sm text-destructive">{state.message}</p>
          )}

          {state.kind === 'expired' && (
            <p className="text-sm text-muted-foreground">
              This invitation has expired. Ask the workspace admin to send a new one.
            </p>
          )}

          {state.kind === 'already' && (
            <p className="text-sm text-muted-foreground">
              This invitation was already {state.status.toLowerCase()}.
            </p>
          )}

          {state.kind === 'needs-auth' && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Sign up or log in as <strong>{state.email}</strong> to accept.
              </p>
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  onClick={() => {
                    if (token) rememberPendingInvite(token)
                    navigate(`/signup?email=${encodeURIComponent(state.email)}`)
                  }}
                >
                  Sign up
                </Button>
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    if (token) rememberPendingInvite(token)
                    navigate(`/login?email=${encodeURIComponent(state.email)}`)
                  }}
                >
                  Log in
                </Button>
              </div>
            </div>
          )}

          {state.kind === 'needs-verify' && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Verify your email to finish joining.
              </p>
              <Button asChild>
                <Link
                  to="/verify-email-pending"
                  onClick={() => token && rememberPendingInvite(token)}
                >
                  Verify email
                </Link>
              </Button>
            </div>
          )}

          {state.kind === 'mismatch' && (
            <p className="text-sm text-destructive">
              This invite was sent to {state.invitedEmail}, but you're signed in as{' '}
              {state.currentEmail}. Log out and sign in with the invited email.
            </p>
          )}

          {accept.isError && (
            <p className="text-sm text-destructive">
              Could not accept the invitation. It may have expired or been revoked.
            </p>
          )}

          {(state.kind === 'ready' || state.kind === 'mismatch') && token && (
            <Button
              variant="ghost"
              disabled={reject.isPending}
              onClick={() =>
                reject.mutate(token, { onSuccess: () => navigate('/', { replace: true }) })
              }
            >
              Decline
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
```

> Verify `useAuth()` exposes `user.email`, `workspaces`, and `lastAccessedWorkspace` (index-redirect.tsx uses these). If shapes differ, adapt the destructure. Install shadcn `card` if not present via the shadcn MCP (`get_add_command_for_items`) before importing it.

- [ ] **Step 4: Thin page + route**

```tsx
// socialmedia-frontend/src/pages/invite/accept.tsx
import { AcceptInvitationView } from '@/features/team/components/accept-invitation-view'

export default function AcceptInvitationPage() {
  return <AcceptInvitationView />
}
```

In `router.tsx`, add a PUBLIC route (sibling of `/login` and `/signup`, outside the authenticated shell):

```tsx
import AcceptInvitationPage from '@/pages/invite/accept'
// ...
<Route path="/invite/accept" element={<AcceptInvitationPage />} />
```

> Match the file's existing public-route pattern (how `/login`, `/signup` are declared). The accept page renders for both authed and unauthed users, so it must NOT sit behind `ProtectedRoute`.

- [ ] **Step 5: Typecheck / build**

Run: `cd socialmedia-frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 6: Manual end-to-end verification**

1. Set backend `FRONTEND_URL=http://localhost:3010` (or the dev frontend port) and a working `RESEND_API_KEY` (or watch server logs for the logged email).
2. As an owner, invite a NEW email from Team settings.
3. Open the accept link from the email/log. Confirm the preview shows workspace + inviter.
4. Click "Sign up" → email is prefilled → complete signup + OTP verify → you are redirected back and auto-joined into the inviter's workspace (not create-workspace onboarding).
5. Repeat with an EXISTING logged-in user whose email matches → one click accept.
6. Log in as a DIFFERENT email, open the link → mismatch error shown.

- [ ] **Step 7: Commit**

```bash
git add socialmedia-frontend/src/features/team/components/accept-invitation-view.tsx socialmedia-frontend/src/pages/invite/accept.tsx socialmedia-frontend/src/router.tsx socialmedia-frontend/src/pages/index-redirect.tsx socialmedia-frontend/src/features/auth/components/login-form.tsx socialmedia-frontend/src/features/auth/components/signup-form.tsx
git commit -m "feat(team): accept-invitation page + signup-first auto-accept"
```

---

## Self-Review Notes

- **Spec coverage (Phase 1 slice = spec §3, §4, §9):** email wiring (T1–T2), public preview (T3), accept/reject API + hooks (T4), signup-first auto-accept via storage + IndexRedirect + accept page (T5–T7). Resend (§4), batch/seat gating (§5), role guards (§6), rich dialog + billing gate (§7–§8), my-invitations inbox (§10) are intentionally deferred to Phase 2/3 plans.
- **Deferred within Phase 1:** none of the above leaks in; the existing single-invite dialog is reused unchanged.
- **Type consistency:** `MemberRole` reused from `types/team.ts`; `InvitationPreview` shared by API + resolver + view; `resolveAcceptState` input matches `useAuth()` fields used in `index-redirect.tsx`.
- **Assumptions to verify during execution (flagged inline):** `workspace.schema` has a `name` column; `useAuth()` exposes `user.email`/`workspaces`/`lastAccessedWorkspace`; router's public-route pattern; shadcn `card` installed.
```
