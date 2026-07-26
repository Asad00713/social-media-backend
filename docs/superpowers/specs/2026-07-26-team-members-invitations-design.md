# Team Members & Invitations — Design

> **Status:** APPROVED (pending final spec review). Design locked 2026-07-26.
> Full-stack effort across both repos. New branch off `main` on each.

**Goal:** Ship a complete, production-grade team invitation + membership + role-permission
system. Owners/admins invite teammates by email (multiple at once, each with a role); invitees
receive a real email, land on an accept page, sign up if needed, and auto-join. Roles gate
what each member can do — enforced on the backend and reflected in the UI. When a workspace is
out of member seats, the invite action surfaces the existing billing upgrade / add-on flow
instead of the invite form.

**Architecture:** ~80% of the plumbing already exists (invite/accept/reject/cancel/members/
roles service, member-limit + extra-member add-on billing, a mature billing/plans/add-on UI,
a capable EmailService, a real Team settings page). This effort fills the gaps and raises the
invite UX to reference quality. No new DB table; no schema migration.

**Tech stack:** NestJS + Drizzle + Resend (backend); Vite + React 19 + shadcn/ui + TanStack
Query (frontend).

## Global Constraints

- **shadcn-only** UI; components via shadcn MCP; theme tokens only.
- **Email invites only** — no public "anyone with link" join model in this effort.
- **No DB schema migration** — reuse existing tables/enums (`workspace_invitations`,
  `member_role`, `invitation_status`, `workspace_usage`, `plans`). `db:generate`/`db:push`
  are NOT run.
- **Role gating enforced on the backend** (guards = real security) AND mirrored in the UI
  (hide/disable). UI gating alone is never the security boundary.
- Capability→role mapping is a **single source of truth**, mirrored backend↔frontend; the
  invite-dialog permission copy is derived from it (copy and enforcement never drift).
- OAuth tokens never reach the browser (unchanged).
- Seat accounting excludes the owner (consistent with existing `members_count`, which counts
  accepted invitations only). Confirm plan-seed seat semantics during planning.

---

## 1. Locked decisions

| Question | Decision |
|---|---|
| New-user accept path | **Signup-first → auto-accept.** Link → if no account, signup/login (email prefilled+locked) → after auth (+ OTP verify for new users), auto-accept → land in workspace. |
| V1 scope | **Full team management:** invite→email→accept loop, resend, "my invitations" inbox, role permission gating. |
| Role matrix | Default + **MEMBER can connect/disconnect channels** (see §2). |
| Enforcement depth | **Backend guards + UI hide/disable.** |
| Link sharing | **Email invites only** (no public join-link). |
| Multi-invite | **Yes** — add multiple recipients at once, each with a role. |
| Seat-full (paid) | **Both** add-on (extra seats) **and** plan upgrade in one dialog. |
| Dialog model | **Rich invite dialog** for adding people; current-member management stays on the Team settings page. |

## 2. Membership & role model + capability map

No new table. Membership = `workspace_invitations` rows with `status = ACCEPTED`; role lives on
the row. OWNER is `workspace.ownerId` (not an invitation row).

New **`WorkspaceRoleService.getRole(workspaceId, userId): 'OWNER'|'ADMIN'|'MEMBER'|'GUEST'|null`**:
- `userId === workspace.ownerId` → `OWNER`
- else accepted invitation's role → `ADMIN`/`MEMBER`/`GUEST`
- else `null` (not a member)

*(Considered & deferred: a dedicated `workspace_members` table — rewiring/migration risk with no
v1 functional gain; the invitation-as-membership model already backs `getMembers`/`isUserAdmin`/
member-count. Rename/normalize later.)*

**Capability map — single source of truth (mirrored backend + frontend):**
```
ROLE_RANK: OWNER=4, ADMIN=3, MEMBER=2, GUEST=1
CAPABILITY_MIN_ROLE:
  billing:manage    → OWNER
  workspace:delete  → OWNER
  team:manage       → ADMIN     (invite / role change / remove / resend)
  channels:manage   → MEMBER    (connect / disconnect)
  posts:publish     → MEMBER    (create / edit / publish / schedule)
  inbox:reply       → MEMBER
  posts:draft       → GUEST
  inbox:view        → GUEST
  analytics:view    → GUEST
can(cap, role) = ROLE_RANK[role] >= ROLE_RANK[CAPABILITY_MIN_ROLE[cap]]
```
Human-readable per-role permission summaries (Admin/Member/Guest) are **derived from this map**
and shown in the invite dialog and the role-change dropdown.

## 3. Backend — email wiring (the current blocker)

- Add `EmailService.sendWorkspaceInvitation(email, { workspaceName, inviterName, role, token,
  expiresAt })` — same template style as existing emails; builds the accept URL from its own
  `frontendUrl`: `${frontendUrl}/invite/accept?token=<token>`.
- Replace the `// TODO: Send email` at `workspace-members.service.ts:134` with a call to it
  (after the invitation row is created). Failure to send is logged; the invitation still
  exists (resend covers delivery retries).
- **Env:** accept links depend on `FRONTEND_URL` — must be `https://app.schedura.ai` in prod
  (user sets on Railway).

## 4. Backend — accept / reject / preview / resend

- **Public preview:** `GET /workspace-members/invitations/preview?token=` — **no auth guard**,
  returns only safe fields: `{ workspaceName, inviterName, invitedEmail, role, status,
  expired }`. Powers the pre-login accept screen. Never returns the token or member lists.
- `acceptInvitation` / `rejectInvitation` already exist (auth + email-match) — keep.
- **Resend:** `POST /workspace-members/:workspaceId/invitations/:invitationId/resend`
  (`team:manage`) — rotate token, extend `expiresAt` +7d, re-send email. Only for `PENDING`.

## 5. Backend — batch invite + seat gating

- **Batch endpoint:** `POST /workspace-members/:workspaceId/invitations/batch`
  body `{ invites: Array<{ email: string; role: 'ADMIN'|'MEMBER'|'GUEST' }> }` (`team:manage`).
- **Seat gate (up front, whole-batch atomic):** reserved seats = `members_count` (accepted) +
  `pending invitations count`. Reject the **entire** batch with a typed error
  (`SEAT_LIMIT_EXCEEDED`, includes `membersAvailable`) if
  `reserved + batch.length > membersLimit (incl. extraMembersPurchased)`. This makes pending
  invites reserve a seat, preventing over-invite beyond the plan.
- Per-invite validation (reuse existing rules): valid email, not the owner, not already an
  accepted member, no existing pending invite. Duplicates are **skipped**, not fatal.
- On success: create rows + send one email each; return per-invite results
  `{ email, status: 'invited' | 'skipped', reason? }` so the UI can show partial outcomes.
- Keep the single-invite endpoint as a thin delegate to the batch path (one code path for
  validation + seat gate).
- `members_count` still increments only on **accept** (billing unchanged); the seat *gate*
  counts pending + accepted.

## 6. Backend — role guard + capability enforcement

- New **`WorkspaceRoleGuard`** + `@RequireCapability('posts:publish')` decorator, using
  `WorkspaceRoleService` + the capability map; resolves `workspaceId` from the route param
  (fallback: body/query where the param name differs — enumerate per controller in the plan).
- Apply to mutating endpoints per the matrix. Endpoint inventory (exact list finalized in the
  plan; grouped by capability here):
  - `team:manage` → workspace-members invite/batch/resend/role-update/remove/cancel.
  - `channels:manage` → channels connect / oauth-callback-create / delete / update.
  - `posts:publish` → posts create/update/publish/schedule/delete; drips create/update.
  - `inbox:reply` → inbox/messaging reply/send endpoints.
  - `billing:manage` / `workspace:delete` → subscription/addon/plan-change; workspace delete.
- GUEST-allowed reads (`analytics:view`, `inbox:view`, `posts:draft`) are not gated beyond
  workspace membership.

## 7. Frontend — rich invite dialog (reference quality)

Redesign `invite-member-dialog.tsx` to Untitled-UI quality (shadcn primitives only):
- **Multi-recipient input:** type an email → Enter/comma adds it as a **chip**; each chip has
  a **role dropdown** (Admin/Member/Guest, default Member). Invalid email → inline error;
  duplicate → ignored.
- Each role option shows its **permission summary** derived from the capability map (§2).
- **Seat awareness inside the dialog:** show "N seats left" from workspace usage. If chips
  added > `membersAvailable`, block Send and show an inline CTA that opens the upgrade/add-on
  dialog (§8). On Send, call the batch endpoint; render per-invite results (invited / skipped).
- Loading / disabled / error / empty states throughout (Rule 4).
- Current members are **not** listed here — management stays on the Team page.

## 8. Frontend — seat-limit → upgrade / add-on dialog (reuse billing)

- **Gate at the invite entry point** (Team page "Invite people" button + empty-state CTA):
  read workspace usage (`membersAvailable`) via the existing billing usage hook.
  - `membersAvailable <= 0` (or no subscription / free with 0 invitable seats) → open the
    **seat-upgrade dialog** instead of the invite dialog.
  - `membersAvailable > 0` → open the invite dialog.
- **Seat-upgrade dialog composes existing billing components** (no new "local" UI):
  - **Add-on path:** extra member seats via `purchase-addon-dialog` / `use-purchase-addon`
    (`extraMembersPurchased`).
  - **Upgrade path:** higher-plan cards + `billing-cycle-toggle` (Yearly/Monthly) — reuse
    `plans` components (image-3 style).
  - Present **both** in one dialog (add-on primary, upgrade secondary), professional layout.
- After a successful add-on/upgrade, usage refetches; the invite dialog becomes reachable.

## 9. Frontend — accept page + signup-first auto-accept

- New **public route `/invite/accept?token=`** → `AcceptInvitationPage`.
- Loads the **preview** (§4) to show "You've been invited to *<workspace>* by *<inviter>* as
  *<role>*." Handle `expired` / `already accepted` / `not found` states.
- **Not logged in:** "Sign up" / "Log in" buttons carry `returnTo=/invite/accept?token=…` and
  the invited email (prefilled + locked). After auth (new users complete the existing OTP
  email verification) → return to this page → **auto-accept**.
- **Logged in + email matches:** "Accept" → POST accept → navigate into the workspace;
  "Decline" → reject.
- **Email mismatch:** clear error ("This invite was sent to *a@b.com*; you're signed in as
  *c@d.com* — log out and sign in with the invited email").
- Add `team.api.ts` wrappers + hooks: `previewInvitation`, `acceptInvitation`,
  `rejectInvitation`, `resendInvitation`, `batchInvite`. Verify the auth flow supports
  `returnTo` + prefilled/locked email (integration dependency to confirm in the plan).

## 10. Frontend — my-invitations inbox, gating, resend, capability helper

- **My invitations inbox:** surface `getMyInvitations` (already on backend) — a small inbox
  (in the notifications area or a `/invitations` page) listing pending invites addressed to me
  with inline Accept / Decline.
- **`useWorkspaceRole(workspaceId)`** (from members data + auth user) + **`can(capability)`**
  helper (mirrored capability map).
- **App-wide UI gating** (hide/disable + route guards), matching backend guards:
  - Billing pages: non-OWNER → read-only/blocked.
  - Team management actions (invite/role/remove/resend): non-`team:manage` hidden.
  - Channel connect/disconnect: GUEST hidden.
  - Composer publish/schedule: GUEST → draft-only.
  - Inbox reply: GUEST → view-only.
- **Team page:** add resend action on pending rows; ensure role-change dropdown shows the
  same permission summaries as the invite dialog.

## 11. Data / migration / env

- **No schema migration.** Existing tables/enums cover everything.
- Env: `FRONTEND_URL` (accept links), `RESEND_API_KEY` + `RESEND_FROM_EMAIL` (already used).
- No `db:generate` / `db:push`.

## 12. Testing

- Role resolver: owner / admin / member / guest / non-member → correct role.
- Capability map parity: backend and frontend maps identical (a shared fixture or generated
  test); every capability has a min-role.
- Guard: for each gated capability, allowed roles pass and lower roles get 403.
- Batch invite: happy path; duplicate skip; **seat gate rejects whole batch** when
  reserved+batch > limit; pending invites reserve seats.
- Accept: happy path; email-mismatch; expired; already-accepted; new-user signup-first
  auto-accept.
- Email: `sendWorkspaceInvitation` builds correct accept URL; resend rotates token + extends
  expiry.
- Frontend: invite dialog multi-chip + per-role + seat CTA; seat-full opens upgrade/add-on
  dialog (not invite form); accept page states; UI gating hides/disables per role.

## 13. Out of scope

- Public "anyone with link" join model.
- `workspace_members` table normalization (rename/migrate later).
- Maestro-bridge / channel billing changes (tracked separately).
- Any new plan prices; changing what a plan grants.

## 14. Branching

New effort → its own branch off `main` on **both** repos (backend: email/service/guard/batch;
frontend: dialog/accept-page/gating). Not piled onto any current branch.
