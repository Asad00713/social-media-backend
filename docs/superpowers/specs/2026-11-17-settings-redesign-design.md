# Settings redesign — design

Date: 2026-11-17. Status: scope approved by the owner (decisions in §3), planning only.

Repos and worktrees:
- Frontend `socialmedia-frontend`, worktree `socialmedia-frontend-settings` (base `origin/main` c3b7743b).
- Backend `socialmedia-workspace`, worktree `socialmedia-workspace-settings` (base `origin/main` f71a010).

Sources:
- Figma exports: `backups/figma-exports/settings-2026/` (files 01–44, 50–56). Verbatim copy catalogues in the session scratchpad `settings-research/`: `design-account.md`, `design-workspace.md`, `design-brand-labels-phone.md`.
- Code research in the same folder: `fe-inventory.md` (current FE), `be-gaps.md` (BE gaps and the 2FA research).
- Screen numbers below (5c, 6d, 7g…) are the Figma flow-map numbers. Figma file numbers are written `F14`, `F26`…

Decisions marked **My call** were made while writing this spec, not by the owner. Each says why, so the owner can overturn it. Items marked **Builder call** are left to the person writing the plan or the code, with a default.

---

## 1. Intent

Settings today is a list of unrelated pages that grew one at a time:
- Nothing is gated by role. A guest sees Billing, Team, Channels and General. General's form saves for any role (the API is owner-only, so the save fails).
- Several controls do nothing. Language and time zone are stored in localStorage and nothing reads them. "Log out of all sessions" is permanently disabled. "Upload logo" is disabled. Tags is a stub with no table. The cancel-plan feedback is collected and dropped.
- Billing still assumes Stripe (Stripe Elements card form, "Stripe" copy), although Lemon Squeezy is the live provider.
- Account deletion hard-deletes the user, which silently cascades into every workspace they own, and 500s for any user who ever invited someone or changed a plan.
- There is no two-step sign-in and no way to see or end a session.

The 2026 Figma redesign gives Settings one shape: a settings-mode sidebar with four groups, one row-and-card layout, one save rule, and an explicit "who sees what" rule. This effort builds every screen in that design except the API group and Transfer ownership, with real backend support behind every control.

## 2. Goals, non-goals, anti-goals

### Goals
1. One settings shell: the settings nav, role gating enforced on the API, the shared page container, and the save rule (§6), used by every page.
2. Every in-scope Figma screen built to the design, with the copy deviations listed in §3.4 and §11.
3. Every control persists on the server and changes behaviour somewhere. No localStorage-only settings remain (localStorage may cache a server value for first paint).
4. Account deletion is safe: blocked while the user owns a workspace, soft-deleted and anonymised, never cascading.
5. Two-step sign-in (TOTP plus backup codes) and a real session list, with no token-minting path that skips the second factor.
6. Labels become a real catalogue with colour, description, counts, merge and undoable delete, used by the composer and the Planner filter.
7. Maestro & brand: an editable brand voice that Maestro actually reads, a relearn job, and workspace Maestro settings enforced in code.

### Non-goals
- The API group (screens 10, 10a–c). The nav has no Developers group.
- Transfer ownership (5a). Publer forbids it, Planable has no self-serve flow, and our billing is per user. The General page has no Transfer button.
- An email digest. It stays hidden, as decided in the email-notifications spec (§2 there). The Notifications page has no Digest row.
- Per-member channel access ("Only these channels" in 6b, "Channel access…" in the member menu). That needs channel-level authorisation in the composer, Planner, Inbox, Insights and publishers. **My call:** it is a module of its own, not a settings page. The invite dialog's More options keeps only the personal message.
- One-off AI credit packs (see §5.7.4 and owner question Q2).
- A Library Brand Kit editor. The brand-kit row links out only when that page exists (§9.2).
- Interface translations. The Language row ships with the locales the app actually has (§5.3).
- City-level session location. Sessions show the country only (owner decision).

### Anti-goals (things this effort must not do)
- Ship a control that saves but changes nothing. If the behaviour cannot be built, the control is not shown.
- Add a Save/Reset bar, a sticky footer, or a page-level edge-to-edge layout.
- Mint an access or refresh token anywhere except the shared session issuer (Part B).
- Send Threads-API-sourced data to an LLM (Part C).
- Remove the backend Stripe adapter. Only the FE Stripe card form and Stripe copy go; the BE stays dual-provider.

## 3. Owner decisions (binding)

### 3.1 Scope
Every Settings screen except API (10, 10a–c) and Transfer ownership (5a). The Transfer ownership entry point is removed from General too.

### 3.2 Delivery: three parts, each a BE PR plus an FE PR
| Part | Contents |
|---|---|
| **A** | Settings shell and nav with role gating; Profile (incl. Leave workspace, Google disconnect, password-changed-at); Security page with the Sign-in section only; Preferences (server-persisted); Notifications (existing matrix + Pause); General; Members; Plan & billing on Lemon Squeezy; Labels; the account-delete fix |
| **B** | Sessions (`user_sessions`, session-id claim, list, revoke one, revoke others, 30-day idle expiry); TOTP two-step sign-in with backup codes, through one session issuer |
| **C** | Maestro & brand: brand voice record with per-field edited flags, async relearn, preview endpoints, Maestro workspace settings incl. who-can-use enforced server-side, credits display |

Each part merges BE first, then FE. A part's FE PR never ships against an unmerged BE.

### 3.3 Account delete
Blocked while the user owns any workspace; the dialog lists them, each with "Open General". Typed-email confirm. Soft delete plus anonymisation instead of a hard delete. FKs that would error are fixed.

### 3.4 Copy changes against the design
| Where | Design | Ships as |
|---|---|---|
| Security, backup codes row and the "Two-step sign-in is on" toast | "View codes" | "Regenerate codes" (codes are hashed; they cannot be shown again) |
| Security, session rows | "Karachi, Pakistan · 2 hours ago" | "Pakistan · 2 hours ago" (country only) |
| Delete workspace dialog (5b) | "The Max plan is cancelled. No refund for this month." | Shown only when this is the owner's last owned workspace |
| Members nav for a member | Frame F17 shows Plan & billing | Hidden (flow map rule wins) |
| General, time-zone popover | Truncated labels | "Use for new channels" / "Also move existing" |

### 3.5 Engineering rules
- Migrations start at **0090** (main took 0088 and 0089 first; renumbered at the merge with main). The boot migrator applies by filename and tracks name plus checksum. Any `ALTER` on `users` or `workspace` starts with `SET LOCAL lock_timeout = '5s'` and is listed in `migrate/inbox-lock-timeout.spec.ts`.
- BullMQ job ids never contain `:`.
- Every new `toast.error` passes `{ error }`.
- The save rule from the flow map (§6).
- Settings container: `mx-auto flex w-full max-w-5xl flex-col gap-6 py-6 md:px-6 lg:px-8` plus the shared `PageHeader`. No page joins the shell's edge-to-edge list.
- New dependency approved: `otpauth` 9.6.0 (BE, Part B). FE already has `qrcode.react`, `input-otp` and `react-image-crop`. No other new dependency is expected; if one turns up, stop and ask.

---

## 4. Roles and capabilities

### 4.1 Who sees what (flow map, verbatim rule)
"Guests see the Account group only. Members see Workspace pages read-only (5c) and no Plan & billing. Admins change everything except Plan & billing and Delete. The owner sees all."

**My call:** the Content group (Labels) follows the Workspace rule for visibility (guests do not see it). Members may manage labels, because they already create labels from the composer; a page that let them create but not rename would be odd.

### 4.2 New capabilities (BE `role-capabilities.ts` and the FE mirror `features/team/utils/capabilities.ts`)
| Capability | Min role | Used by |
|---|---|---|
| `settings:view` | MEMBER | Read any Workspace or Content settings page: `GET /workspace/:id`, the Members page shell, Maestro & brand read, Labels page |
| `workspace:manage` | ADMIN | Edit General: name, logo, time zone, publishing defaults |
| `labels:manage` | MEMBER | Create, edit, merge, delete labels |

Existing capabilities keep their levels: `billing:manage` OWNER, `workspace:delete` OWNER, `team:manage` ADMIN, `brand:manage` ADMIN, `posts:draft` GUEST, `team:view` GUEST.

### 4.3 Page and action matrix
| Page / action | Guest | Member | Admin | Owner | Capability (API) |
|---|---|---|---|---|---|
| Profile, Preferences, Notifications, Security | ✓ | ✓ | ✓ | ✓ | Jwt only |
| Leave a workspace | ✓ | ✓ | ✓ | — (owner cannot leave) | caller-member endpoint |
| General: view | — | read-only | ✓ | ✓ | `settings:view` |
| General: edit | — | — | ✓ | ✓ | `workspace:manage` |
| General: delete workspace, Ownership row | — | — | — | ✓ | `workspace:delete` |
| Members: view | — | read-only | ✓ | ✓ | `settings:view` (page), `team:view` (list API) |
| Members: invite, role change, remove, invite link | — | — | ✓ | ✓ | `team:manage` |
| Members: "Add N seats" | — | — | — (disabled, tooltip) | ✓ | `billing:manage` |
| Plan & billing | — | — | — | ✓ | `billing:manage` |
| Maestro & brand: view | — | read-only | ✓ | ✓ | `settings:view` |
| Maestro & brand: edit, relearn | — | — | ✓ | ✓ | `brand:manage` |
| Labels: view | — | ✓ | ✓ | ✓ | `settings:view` (page), `posts:draft` (list API) |
| Labels: manage | — | ✓ | ✓ | ✓ | `labels:manage` |
| Channels ↗, Saved replies ↗, Calendar sync ↗, Hashtags & snippets ↗ | — | ✓ | ✓ | ✓ | destination's own rules |

Enforcement:
- **API:** every write in this spec carries `@RequireCapability`. `every-workspace-route-guarded.spec.ts` must pass with the new routes; caller-scoped routes without a capability (leave workspace) go in `open-workspace-routes.ts` with a reason.
- **FE nav:** each `SETTINGS_NAV` item gets `capability?: Capability`. The nav hides items the role cannot view. Groups with no visible item are hidden.
- **FE routes:** a `SettingsCapabilityRoute` wrapper (`components/routes/`) per route. While the role is loading it renders the page skeleton, never a redirect. A role without the capability is redirected to `settings/profile`.
- **FE read-only:** pages read `useWorkspaceCan('<edit capability>')` and render the 5c read-only state (lock line, disabled controls, no destructive sections).

### 4.4 The "What each role can do" dialog (6d)
The dialog shows the rules the server enforces, from one FE constant `ROLE_MATRIX` in `features/team/constants/role-matrix.ts`, with a unit test that ties each row to `CAPABILITY_MIN_ROLE` where a capability exists.

| Row | Owner | Admin | Member | Guest | Source |
|---|---|---|---|---|---|
| Create and schedule posts | ✓ | ✓ | ✓ | — | `posts:publish` |
| Publish without approval | ✓ | ✓ | If allowed | — | approval policy (§5.5) |
| Approve posts | ✓ | ✓ | — | — | `posts:approve` |
| Reply in Social inbox | ✓ | ✓ | ✓ | — | `inbox:reply` |
| Comment on posts | ✓ | ✓ | ✓ | ✓ | |
| Connect channels | ✓ | ✓ | ✓ | — | `channels:manage` (MEMBER today) |
| Invite people | ✓ | ✓ | — | — | `team:manage` |
| Change workspace settings | ✓ | ✓ | — | — | `workspace:manage` |
| Plan and billing | ✓ | — | — | — | `billing:manage` |
| Delete the workspace | ✓ | — | — | — | `workspace:delete` |
| Uses a seat | ✓ | ✓ | ✓ | Free | |

Two cells differ from Figma F23 because the design and the server disagree:
- **Connect channels / Member:** Figma "—", server ✓. See owner question Q1. Until answered, the dialog states the server truth.
- **Approve posts / Guest:** Figma "When asked". No guest approval flow exists, so the cell is "—" and General's approval helper drops "Guests approve when they're asked." **My call:** a guest approval flow is new product work, not a settings change.

The footer note stays: "“If allowed” follows Approval before publishing in General."

---

## 5. Part A

### 5.1 Settings shell and navigation

**Data:** `GET /auth/me` (role per workspace, already present), `useWorkspaceCan`.

**Nav** (`features/dashboard/constants/settings-nav.ts`, Hugeicons per `docs/design/icon-map.md`):
| Group | Item | Route under `/w/:id/settings/` | Capability to see | External ↗ |
|---|---|---|---|---|
| Account | Profile | `profile` | — | |
| | Preferences | `preferences` | — | |
| | Notifications | `notifications` | — | |
| | Security | `security` (new) | — | |
| Workspace | General | `general` | `settings:view` | |
| | Members | `members` (new; `team` redirects) | `settings:view` | |
| | Plan & billing | `billing` (`plans` redirects to `billing?plans=compare`) | `billing:manage` | |
| | Maestro & brand | `maestro` (added in Part C) | `settings:view` | |
| | Channels | → Channels page | `settings:view` | ↗ |
| Content | Labels | `labels` (`tags` redirects) | `settings:view` | |
| | Saved replies | → `<inbox>?settings=saved-replies` (existing) | `settings:view` | ↗ |
| | Calendar sync | → Planner settings › Calendars (`settings/calendar` redirects there) | `settings:view` | ↗ |
| | Hashtags & snippets | → Library hashtags tab | `settings:view` | ↗ |

- External items render the trailing ↗ icon and leave settings mode. **Builder call:** the exact Planner and Library deep-link params; read the Planner settings dialog and Library routing for the existing param names.
- Unlisted routes keep working: `integrations` (redirect), `ad-accounts`.
- `route-title.ts` and the command palette read the new nav. The command palette lists only items the role can see.

**Shell behaviour (flow map):**
- Entry: sidebar Workspace › Settings, the account menu › Settings, and **⌘ ,** / **Ctrl ,** (new `ShortcutId` `settings` in `features/dashboard/constants/shortcuts.ts`, handled in `hotkeys.ts`).
- "‹ Settings" goes back to the last non-settings page. The shell writes the last non-settings path to `sessionStorage` (try/catch); without one, it goes to the workspace home.
- The workspace switcher stays. Its subline is "{Plan} plan · {n} members" (owner's plan; members exclude guests).
- The bottom user chip shows the caller's role in the current workspace.
- Active item uses `bg-selected`.
- Desktop `settings` index redirects to `profile`.

**Phone (m1):** at <768 px, `settings` (index) renders the nav as an inset-grouped list (`SettingsNavList`): group caption above a `Card`, rows = icon, label, trailing chevron or ↗. Each page shows a back chevron to the index in the Panel topbar. Page CTAs (Invite, New label) go top-right in the topbar.

**FE:**
- `features/dashboard/components/sidebar-settings-nav.tsx` (rewrite: groups, capability filter, ↗ items, back to last page).
- `features/dashboard/components/settings-nav-list.tsx` (phone index).
- `features/settings/` (new feature folder for the shared settings kit):
  - `components/settings-page.tsx` — the container from §3.5 plus `PageHeader`; every settings page renders through it.
  - `components/settings-section.tsx` — heading (`text-15 font-semibold`), optional helper, optional right-side action, then a shadcn `Card` whose rows are separated by `Separator` / `divide-y divide-border`.
  - `components/settings-row.tsx` — shadcn `Item` composition: label + helper left, control right; stacks below `md`. Replaces `components/shared/settings-row.tsx` (its old consumers are all redesigned here; the planner and inbox keep their own rows).
  - `components/saved-indicator.tsx`, `components/text-save-field.tsx`, `hooks/use-instant-save.ts` (§6).
  - `components/read-only-note.tsx` — the 5c lock line.
  - `components/routes/settings-capability-route.tsx` lives in `src/components/routes/`.
- Pages in `src/pages/settings/` stay thin (≤ 15 lines).

### 5.2 Profile (screens 1, 1a, 1b, 1c; F01–F04, F09)

**Layout** (F01): Identity card → "Your details" → "Your workspaces" → "Danger zone" → footer note "Language, time zone and theme are in Preferences. Password, two-step sign-in and sessions are in Security." The current Region section and the RHF footer row are removed.

| Block | Data | Endpoint |
|---|---|---|
| Identity card: avatar 72 px, name, "{email} · {Role} of {current workspace}", "Change photo" menu | user, current workspace role | `GET /auth/me` |
| Change photo → Upload (file picker → circular crop with `react-image-crop`, JPG/PNG/WebP, ≤2 MB) / Remove (red) | | existing `POST /users/:id/avatar/presign` → PUT to R2 → `PATCH /users/:id/avatar` |
| Full name (text field, §6 Save) | `user.name` | existing `PATCH /users/:id {name}`. **BE change:** `@MaxLength(60)` to match signup |
| Email row + "Change email" (1a → 1b) | | existing `POST /users/me/email-change`, `POST /users/me/email-change/confirm` |
| Your workspaces list | per workspace: id, name, logo, my role, plan name, invited-by name, isCurrent | **new** `GET /users/me/workspaces` |
| Leave (confirm dialog) | | **new** `DELETE /workspace-members/:workspaceId/members/me` |
| Delete account (1c) | owned workspaces, member workspaces, email | `GET /users/me/workspaces` + **new** `DELETE /users/me` |

**New endpoints:**
- `GET /users/me/workspaces` (Jwt) →
  ```ts
  interface MyWorkspace {
    id: string; name: string; logo: string | null;
    role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST';
    planName: string | null;      // the workspace owner's plan
    invitedByName: string | null; // null for the owner
    ownerName: string;
  }
  // response: { workspaces: MyWorkspace[] }
  ```
  Ordered: current first (FE), then owned, then by name. Row sublines: owner → "Owner · {plan} plan"; others → "{Role} · invited by {name}" (or "{Role}" when the inviter is gone).
- `DELETE /workspace-members/:workspaceId/members/me` (Jwt + WorkspaceRoleGuard, any role; listed in `open-workspace-routes.ts`) → `204`. Resolves the caller's ACCEPTED invitation row and reuses the existing self-removal path (soft REMOVED). `409 OWNER_CANNOT_LEAVE` for the owner. After success the FE invalidates `auth.me`; leaving the current workspace navigates to the workspace hub.
- `DELETE /users/me` — see §5.10.

**Dialogs:**
- 1a Change email: restyle of `change-email-dialog.tsx` to F02. Google-only accounts (no password) see the helper "Signed in with Google only? We confirm with Google instead." and the password field is replaced by the existing Google-only path (`currentPassword` optional server-side when no password is set). **Builder call:** keep the current server behaviour for Google-only accounts; the dialog copy follows the design.
- 1b Confirm new email: shadcn `InputOTP` (6 slots), "Resend code" (toast "New code sent to {email}"), footer "Code expires in 10 minutes.", Back / Confirm email. Success toast "Email changed to {email}" with an OK action. Wrong or expired code: inline error under the boxes (existing error mapping in `lib/account-errors.ts`).
- Leave (F09.7): "Leave {workspace}?" / "You lose access right away. Your posts stay with the workspace. {inviter} can invite you again." / Cancel, red Leave. Hidden for owned workspaces.
- 1c Delete account: §5.10.

Copy change: Danger zone helper becomes "Deletes your login and personal settings. Workspaces you own must be deleted first." (no transfer exists).

**FE:** `features/account/components/profile/` — `profile-view.tsx`, `identity-card.tsx`, `change-photo-menu.tsx`, `avatar-crop-dialog.tsx`, `your-details-section.tsx`, `your-workspaces-section.tsx`, `leave-workspace-dialog.tsx`, `delete-account-dialog.tsx`, existing `change-email-dialog.tsx` split into `change-email-dialog.tsx` + `confirm-email-step.tsx`. Hooks: `use-my-workspaces.ts`, `use-leave-workspace.ts`, `use-delete-account.ts` (rewrite). API additions in `features/account/api/account.api.ts`. Query key `queryKeys.account.workspaces`.

### 5.3 Security, Sign-in section only (screen 2, 2a; F05, F06, F09)

Part A ships the Security route with the **Sign-in** section. Part B adds "Two-step sign-in" and "Where you're signed in" to the same page.

| Row | Data | Endpoint |
|---|---|---|
| Google · {email} · "Connected" badge · Disconnect | `hasGoogle` | **new** `POST /users/me/google/disconnect` |
| Google not linked | `hasGoogle=false` | Row shows "Not connected" and a "Connect" button that runs the existing Google link flow (`/auth/google/start` with the link intent the callback already supports). **Builder call:** if the callback cannot link to a signed-in account without a new mode, hide the row instead of adding one. |
| Email and password · "{email} · password changed {relative}" · Change password | `hasPassword`, `passwordChangedAt` | existing `POST /users/me/password` (+ new field) |
| No password set | `hasPassword=false` | "Set password" → existing `SetPasswordDialog` |

**BE changes:**
- `PublicUser` gains `hasGoogle: boolean` (from `googleSub`), `passwordChangedAt: string | null`. (Part B adds `twoFactorEnabled`.)
- Migration 0090 adds `users.password_changed_at timestamptz NULL`, stamped by change-password, set-password and reset-password. Existing rows stay NULL; the FE then omits "password changed …".
- `POST /users/me/google/disconnect {currentPassword}` (Jwt, Throttle 5/h per user) → `PublicUser`. `409 NO_PASSWORD` when `!hasPassword`; `401 WRONG_PASSWORD`. Sets `googleSub = null`. Sends a security email through the email system ("sign-in method changed"; **Builder call:** reuse an existing A-group template if one fits, otherwise add one to the security class).
- `ChangePasswordDto` gains `revokeOtherSessions?: boolean` (default `true`). When `false`, `sessionsRevokedAt` is not stamped. (Part B replaces the stamp with session-row revocation.)

**Dialogs:**
- Disconnect Google? (F09.4): body "You'll sign in with your email and password instead. Only allowed while a password is set." The row's Disconnect is hidden when Google is the only sign-in method. **My call:** the confirm also asks for the current password (an inline password field in the dialog), because removing a sign-in method is a sign-in change (§6 "Sign-in … through a dialog") and OWASP treats it as sensitive.
- 2a Change password (F06): Current password, New password with helper "At least 8 characters. Avoid one you use on other sites.", checkbox "Log out of my other sessions" (checked). Server rules stay (8–128, lower+upper+digit); the zod schema mirrors them and shows the server's rule text on failure. Success toast "Password changed"; when other sessions were logged out, Part B's toast "Logged out of N sessions" replaces it.

**FE:** `features/account/components/security/` — `security-view.tsx`, `sign-in-section.tsx`, `google-row.tsx`, `password-row.tsx`, `disconnect-google-dialog.tsx`, and the existing `change-password-dialog.tsx` moved here and restyled. Hook `use-disconnect-google.ts`.

### 5.4 Preferences (screen 3; F10, F13)

All rows save instantly (§6). Preferences are **per user**, across workspaces (**My call:** they sit in the Account group, and the design says "Times in Schedura show in this zone", not "in this workspace").

| Section | Row | Control | Values |
|---|---|---|---|
| Appearance | Theme · "Auto follows your device." | `ToggleGroup` segmented Light / Dark / Auto | `light \| dark \| system` |
| Language and time | Language | `Select` (globe icon) | shipped locales only (see below) |
| | Time zone · "Times in Schedura show in this zone. Each channel still posts in its own zone." | `Popover` + `Command` search "Search city or zone", rows "City GMT±n", last row "Use my device's zone — {resolved}" | IANA id, or `null` = device |
| | Time format | segmented 12-hour / 24-hour | `12h \| 24h` |
| | Week starts on · "For the Planner, date pickers and reports." | `Select` | `monday \| sunday \| saturday` |
| | Date format | `Select` showing today's date in each format | `D_MMM_YYYY` (16 Oct 2026), `MMM_D_YYYY` (Oct 16, 2026), `DD_MM_YYYY` (16/10/2026), `YYYY_MM_DD` (2026-10-16) |
| Navigation · "Hide modules you don't use. Home and Planner always stay." | Open Schedura on · "The page you land on after signing in." | `Select` with icons | `home \| planner \| inbox \| last` |
| | Home, Planner | lock + "Always shown", tooltip "Home and Planner can't be hidden" | — |
| | Social inbox, Campaigns, Insights, Library | `Switch` | `hiddenModules: ('inbox'\|'campaigns'\|'insights'\|'library')[]` |
| Composer | When I don't pick a time · "What Schedule does when you haven't chosen a date." | `Select`: "Best time to post — Maestro picks per channel", "Next free slot", "Save as draft" | `best_time \| next_free_slot \| draft` |

**Language:** the row lists only locales the app ships. Today that is English, so the select shows "English" with one option, and the helper reads "Changes the interface only. Maestro's writing language is per workspace." **My call:** listing Urdu, Arabic, Spanish and French without translations would be a control that does nothing (anti-goal). The field is stored so translations can be added later without a migration.

**Theme colour swatches** (the current page's extra, not in the design) are removed. **My call:** the design has no colour picker, the swatches are hand-rolled buttons outside the shadcn rule, and the preference is device-local. Listed in §11 for the owner to overturn.

**Endpoints:**
- `GET /users/me/preferences` (Jwt) → `UserPreferences` with every field present (server fills defaults).
- `PATCH /users/me/preferences` (Jwt) body: any subset of the fields → full `UserPreferences`.
  ```ts
  interface UserPreferences {
    theme: 'light' | 'dark' | 'system';
    language: 'en';
    timezone: string | null;            // IANA; null = follow the device
    timeFormat: '12h' | '24h';
    weekStart: 'monday' | 'sunday' | 'saturday';
    dateFormat: 'D_MMM_YYYY' | 'MMM_D_YYYY' | 'DD_MM_YYYY' | 'YYYY_MM_DD';
    startPage: 'home' | 'planner' | 'inbox' | 'last';
    hiddenModules: Array<'inbox' | 'campaigns' | 'insights' | 'library'>;
    composerDefaultWhen: 'best_time' | 'next_free_slot' | 'draft';
  }
  ```
  DTO: class-validator enums for each field; `timezone` validated against `Intl.supportedValuesOf('timeZone')`; `hiddenModules` deduped, max 4.
- Defaults: `system`, `en`, `null`, `12h`, `monday`, `D_MMM_YYYY`, `home`, `[]`, and `composerDefaultWhen` = whatever the composer does today when Schedule is pressed with no time (**Builder call:** read `when-menu.tsx`; existing users must see no change).

**Schema (0090):** `users.preferences jsonb NOT NULL DEFAULT '{}'`. Stored sparse; the service merges defaults on read. The migration also copies each user's most recently updated `planner_preferences.prefs->>'weekStart'` into `preferences.weekStart` when present, so a Planner week-start choice is not lost.

**Where each preference takes effect (all in Part A):**
- `theme`: `ThemeProvider` reads the server value; localStorage keeps a copy for first paint only.
- `timezone`: a new `useDisplayTimezone()` (user pref → device zone) replaces `useWorkspaceTimezone()` at every call site that *displays* a time. Call sites that define *posting* semantics (channel zone, best-time slots, schedule conversion) keep the channel or workspace zone. **Builder call:** audit each `useWorkspaceTimezone` / `workspace-time.ts` caller and record the classification in the plan. Server-side, the email system renders times for a user in this zone when set.
- `timeFormat`, `dateFormat`: `lib/format-prefs.ts` exports `formatDate`, `formatTime`, `formatDateTime` that read the preferences context. Every hard-coded date-fns pattern in Planner, composer schedule chips, Inbox timestamps, Insights and the settings pages moves to these helpers. **Builder call:** the plan lists the call sites found by grep (`format(`, `toLocale`), and the PR migrates all of them.
- `weekStart`: the Planner, date pickers (`Calendar` `weekStartsOn`) and Insights ranges read it. The Planner settings dialog's week-start control reads and writes this same preference (its `planner_preferences` field stops being read).
- `startPage`: the post-login redirect and the workspace root redirect read it; `last` uses the last visited workspace path (existing `lastAccessedWorkspace` plus the stored path).
- `hiddenModules`: the main sidebar, phone nav and command palette hide those modules. Routes stay reachable by URL.
- `composerDefaultWhen`: the composer's Schedule action uses it when no time is picked.

**Migration from localStorage:** on first load, if the server returns `{}`-derived defaults and `app-preferences` / `theme` exist in localStorage, the client PATCHes those values once, then deletes the old keys. Wrapped in try/catch.

**FE:** `contexts/preferences-context.tsx` is rewritten as a React Query-backed provider (`usePreferences()` returns the server value, `useUpdatePreferences()` does the optimistic PATCH). `features/account/components/preferences/` — `preferences-view.tsx`, `appearance-section.tsx`, `language-time-section.tsx`, `timezone-picker.tsx`, `navigation-section.tsx`, `composer-section.tsx`. `lib/format-prefs.ts`, `hooks/use-display-timezone.ts`. The old `personalization-view.tsx`, `theme-settings.tsx`, `region-section.tsx` and `theme-color-provider.tsx` are deleted.

### 5.5 Notifications (screen 4, 4a; F11–F13)

The matrix is the one built in the email-notifications effort and keeps its API (`GET|PUT /workspaces/:id/notification-preferences`). Part A adds **Pause** and normalises the page to the settings kit. No Digest row (§2).

**Layout:**
1. A heading-less card with one row: "Pause notifications" · "Mutes everything except failed posts and security alerts." · `Select` with bell icon: Off, For 1 hour, Until tomorrow, 9:00 AM, Until Monday (the user's `weekStart` day), Custom… (date + time `Popover` with `Calendar`). While paused the row reads "Paused until {when}" with a "Resume" button.
2. "Notify me about" · "For {workspace}. Each workspace has its own settings." — the existing matrix, restyled to F11 (group label rows, locked cells "🔒 Always", "—" cells, Slack column header shows the routed channel or "Not connected").
3. "Slack" section: built from the existing notification-routes data (`GET /notification-routes…`, `channels:manage` to change). Connected: "{Slack workspace} · #{channel}" / "Connected by {name} on {date}" / "Change channel" + "Manage in Channels ↗". Not connected (4a): "Slack isn't connected" / "You'll pick a channel right after connecting." / "Connect Slack" opening the Channels connect dialog at Slack, which returns here. Slack-column switches are disabled while not connected. **Builder call:** if the routes API does not expose the channel list for "Change channel", the button links to Channels instead; nothing is faked.

**Phone (m2, m2a):** the matrix collapses to one row per event with a summary ("In-app, Slack"); tapping opens a bottom `Sheet` with Email / In-app / Slack rows (switch or locked).

**Endpoints (new):**
- `GET /users/me/notifications/pause` → `{ pausedUntil: string | null }` (null when unset or past).
- `PUT /users/me/notifications/pause {until: string | null}` → same. `until` must be in the future and at most 30 days ahead.

**Schema (0090):** `users.notifications_paused_until timestamptz NULL`.

**Behaviour:** `NotificationPreferencesService.shouldSend` returns `false` while `paused_until > now()` for every cell that is not locked, except event `post_failed`. Locked "Always" cells and security events always deliver. Pause is per user, all workspaces. Slack routes are workspace routes, not personal, and are **not** paused (**My call:** muting a team channel because one person paused would surprise the team).

**FE:** `features/account/components/notifications/` — `notifications-view.tsx` (replaces `account-notifications-view.tsx`), `pause-row.tsx`, `pause-picker.tsx`, `slack-section.tsx`, the matrix split into `notification-matrix.tsx` + `matrix-row.tsx` + `matrix-cell.tsx` (the 427-line file is split while restyling), `notification-event-sheet.tsx` (phone). Hook `use-notification-pause.ts`. Remaining `react-iconly` and lucide icons move to Hugeicons.

### 5.6 General (screens 5, 5b, 5c; F14, F16–F18)

**Layout (owner/admin, F14):**
1. **Workspace** card:
   - Logo: 40 px tile (initials fallback) · "Square PNG or JPG, at least 256 px. Shows in the sidebar and on approval links." · Upload (file picker → square crop) · Remove (toast "Logo removed" with Undo).
   - Name: text field (§6 Save), 1–40 chars.
   - Time zone · "Default for new channels and the Planner. Each channel can change its own." · searchable select (same picker as Preferences, without the device row). After a change, a popover under the select asks once: "Use for new channels — Existing channels keep their zone" (default) / "Also move existing — Scheduled posts keep their local time".
   - Workspace ID · "For support and the API." · the full workspace UUID in `font-mono text-13` (middle-truncated on phones) + copy button, tooltip "Copy ID", toast "Workspace ID copied". **My call:** the design's `ws_d92e7c04` is a shortened id that no system accepts; support needs the real one.
2. **Publishing defaults** · "New posts start with these. Anyone can change them on a post in the composer.":
   - Approval before publishing · "Approvers are the owner and admins." · `Select` with descriptions: Off — "Posts publish without review"; Members need approval — "Owner and admins publish directly"; Everyone needs approval — "Even admins send posts for review".
   - Shorten links · "Links become schd.link/... so clicks show in Insights." · `Switch`. **Builder call:** the helper uses the real short-link domain from the short-links API `baseUrl`.
   - Add UTM tags · `Switch`. Helper deviates from F14: "Adds utm_source with the network name and utm_medium=social to every link." **My call:** the composer already writes per-network `utm_source` (`link-utm.ts`); switching every customer's campaigns to `utm_source=schedura` would split their analytics. The setting only sets the composer default.
3. **Ownership** (owner only): owner avatar, name, "Owner · manages billing and can delete the workspace." No button (Transfer is out of scope).
4. **Danger zone** (owner only): "Delete workspace" · "Disconnects {n} channels, cancels {n} scheduled posts and deletes all Insights history. Can't be undone." · red "Delete workspace".

**Member view (5c, F17):** lock line "Only the owner and admins can change workspace settings. Ask {owner name}."; Workspace and Publishing defaults only; every control disabled except the Workspace ID copy.

**Delete workspace dialog (5b, F16):** "Delete {name}" · "This can't be undone. Here's what goes:" · list with red ✕: "{n} channels are disconnected", "{n} scheduled posts are cancelled", "Insights history and the Library are deleted", "{n} members and {n} guests lose access", and, only when `isLastOwnedWorkspace && planName !== 'Free'`, "The {plan} plan is cancelled. No refund for this month." · "Type {name} to confirm" · Cancel / destructive "Delete workspace" enabled on an exact match. Pluralise every line; omit a line whose count is 0.

| Data | Endpoint |
|---|---|
| Workspace detail + defaults + owner name | `GET /workspace/:id` — capability changes from owner-only to `settings:view`. Response adds `approvalPolicy`, `shortenLinksDefault`, `utmDefault`, `ownerId`, `ownerName` |
| Save name / time zone / defaults / logo | `PATCH /workspace/:id` — capability `workspace:manage` (was owner-only) |
| Logo upload target | **new** `POST /workspace/:id/logo/presign {contentType: 'image/png'\|'image/jpeg', sizeBytes ≤ 2 MB}` → `{uploadUrl, publicUrl, key, expiresIn}` (`workspace:manage`) |
| Delete preview | **new** `GET /workspace/:id/deletion-preview` (`workspace:delete`) → `{channels, scheduledPosts, members, guests, isLastOwnedWorkspace, planName}` |
| Delete | `DELETE /workspace/:id/permanent` — body now `{confirmName: string}`; `400 CONFIRM_NAME_MISMATCH` |
| Composer defaults | **new** `GET /workspace/:id/publishing-defaults` (`posts:draft`) → `{approvalPolicy, shortenLinksDefault, utmDefault}` |

**`UpdateWorkspaceDto` changes:**
- `timezone`: IANA-validated.
- `applyTimezoneToChannels?: boolean` (only with `timezone`).
- `logo?: string | null`: `null` clears; a string must be our own R2 `workspace-logo` URL (same own-URL check as avatars).
- `approvalPolicy?: 'none' | 'members' | 'everyone'`, `shortenLinksDefault?: boolean`, `utmDefault?: boolean`.
- `description` stays accepted but has no UI.

**Schema (0091):** `workspace` gains `approval_policy text NOT NULL DEFAULT 'none' CHECK (approval_policy IN ('none','members','everyone'))`, `shorten_links_default boolean NOT NULL DEFAULT false`, `utm_default boolean NOT NULL DEFAULT false`. **My call:** defaults match today's behaviour (approval is opt-in per draft; the composer switches start off), so nothing changes for existing workspaces until someone chooses.

**Behaviour:**
- **Time zone, "Also move existing":** in one transaction, set every channel in the workspace to the new zone; then, for each SCHEDULED post on those channels, keep the wall-clock time in the new zone and reschedule through the existing reschedule path (cancel job + re-enqueue, as the launched-slot time edit does). Returns `{movedChannels, rescheduledPosts}`; the FE toasts "Moved {n} channels. {m} scheduled posts keep their local time." **Builder call:** above ~500 posts, move the reschedule into a BullMQ job (`tz-move-{workspaceId}`) and toast that it is running.
- **Approval policy:** when a draft is created, `approval.required` starts `true` if the author's role is covered (`members`: MEMBER and GUEST; `everyone`: all roles). While the policy covers the author, `canTurnOff` is `false` for everyone on that draft, so the policy cannot be switched off from the composer by the person it applies to; an approver approves instead. `ALLOW_SELF_APPROVAL` keeps its current meaning. Drafts created before a policy change keep their state.
- **Shorten links / UTM:** the composer link panel's initial switch states come from `publishing-defaults`.
- **Delete:** server checks `confirmName` (trimmed, exact). After the existing delete path:
  - BullMQ delayed publish jobs for the workspace's posts are removed (**Builder call:** confirm the processor no-ops on a missing post; remove the jobs anyway).
  - If this was the owner's last owned workspace and the plan is paid, cancel the subscription at period end through the provider adapter.
- **Logo:** R2 key kind `workspace-logo`. Remove does not delete the R2 object immediately, so Undo can restore the URL. **Builder call:** orphan cleanup follows whatever the avatar flow does.

**FE:** `features/workspaces/components/general/` — `general-view.tsx`, `workspace-section.tsx`, `logo-row.tsx`, `logo-crop-dialog.tsx`, `timezone-row.tsx`, `move-timezone-popover.tsx`, `workspace-id-row.tsx`, `publishing-defaults-section.tsx`, `ownership-section.tsx`, `danger-zone-section.tsx`, `delete-workspace-dialog.tsx`. Hooks: `use-workspace-detail.ts` (existing), `use-update-workspace.ts` (existing, per-field), `use-workspace-logo.ts`, `use-deletion-preview.ts`, `use-delete-workspace.ts` (existing, adds `confirmName`). Composer: `link-panel.tsx` reads `usePublishingDefaults()`.

### 5.7 Members (screens 6, 6a–6e; F19–F25, m3)

Redesign on the existing `/workspace-members` API, plus the invite link, personal message, resend, and last active.

**Layout (F19):**
- Topbar: "Members" + primary "Invite people" (`team:manage` only).
- Filter pills (Planner/Inbox pill style): All {n} · Members {n} · Guests {n} · Invited {n}. Right: "{used} of {limit} seats used · guests are free" + "Manage seats" (owner only → `settings/billing`).
- Table (header fixed, rows scroll inside): Name (avatar, name, "You" tag, email) · Role · Last active · kebab.
  - Owner row: role as plain "Owner", no kebab. Your own row: no kebab.
  - Others (for `team:manage`): Role `Select` with descriptions Admin — "All but billing", Member — "Creates and publishes", Guest — "Reviews · free"; saves instantly with "Saved" in the row. Kebab: "Change role ›" submenu, separator, red "Remove from workspace".
  - Invite rows: dashed envelope avatar, email + amber "Invited" badge (or "Expired"), "Invited by {name} · {relative} · expires in {n} days", role as plain text, "—", kebab: Resend invite, Copy invite link, separator, red Revoke invite. Expired rows show "Expired · Resend".
  - Read-only (member) view: no selects, no kebabs, no Invite button, no Invite link section.
- "What can each role do?" link → 6d dialog (§4.4).
- **Invite link** section (`team:manage`): "Anyone with the link joins as a Member and uses a seat." Off: switch off, disabled "Copy link". On: switch on, read-only pill `{FRONTEND_URL}/join/{code}`, "Copy"; second row "Reset link" / "The old link stops working." / "Reset".
- **Empty state "Just you" (6e):** when there are no other members and no invites. `empty-members-art.tsx` (stack of ID cards, theme tokens only), "Invite your team", "Members create and publish posts. Guests, like your clients, review and approve them for free.", primary "Invite people", outline "Copy invite link" (turns the link on and copies it). For a member viewer, the CTAs are hidden and the body explains that admins invite.

**Dialogs:**
- **6a Invite people:** Emails chip input (existing parser), one Role `Select` for all recipients with a helper per role (Admin: "Admins manage members, channels and settings, but not billing."; Member: "Members create and publish posts and reply in Social inbox."; Guest: "Guests review and comment. They're free."), collapsible "More options" summarising "no message" / "with a message", footer "Uses {n} of {free} free seats." / Cancel / "Send {n} invites". Success toast "Invites sent to {n} people"; skipped addresses are listed in the toast description with their reason.
- **6b More options:** only "Personal message (optional)" (textarea, ≤500). Channel access is out of scope (§2).
- **6c Out of seats:** amber banner "Your {plan} plan has {n} seats and {all/both} are used. Add seats, or invite them as guests. Guests are free but can't publish." Footer "{used} of {limit} seats used." / ghost "Invite as guests" (sends the same invites with role GUEST) / primary "Add {n} seats · ${x}/mo" (owner only; admins see it disabled with tooltip "Only the owner can add seats"). Add seats calls the existing add-on purchase (`EXTRA_MEMBER`, quantity = shortfall): on `completed`, the invites are sent; on `checkout_required`, the dialog stores the pending invite (emails, role, message) in `sessionStorage`, redirects to the hosted checkout, and on return (`?invite=resume`) reopens the dialog pre-filled.
- **Remove** (F25.4): "Remove {name}?" / "Their posts and drafts stay. Scheduled posts still go out. A seat frees up." / Cancel, red Remove. The existing Undo toast (15 min restore) stays.

**Endpoints:**
| Need | Endpoint | Change |
|---|---|---|
| Members | `GET /workspace-members/:ws/members` (`team:view`) | add `lastActiveAt` per member (Part A: `users.last_login_at`; Part B: latest `user_sessions.last_used_at`) |
| Invitations | `GET /workspace-members/:ws/invitations` (`team:manage`) | add `invitedByName`, `createdAt`, `expiresAt`, and include EXPIRED invitations from the last 30 days with `status` |
| Invite | `POST /workspace-members/:ws/invitations/batch` (`team:manage`) | add `message?: string` (≤500, plain text, escaped in the email) applied to every recipient |
| Resend | **new** `POST /workspace-members/:ws/invitations/:id/resend` (`team:manage`) | extends `expiresAt` to now + 7 days, keeps the token, re-sends the email; `409` if accepted or revoked; Throttle 10/h per workspace |
| Invite link state | **new** `GET /workspace-members/:ws/invite-link` (`team:manage`) → `{enabled, url \| null}` | |
| Toggle | **new** `PUT /workspace-members/:ws/invite-link {enabled}` (`team:manage`) → same | creates a code on first enable |
| Reset | **new** `POST /workspace-members/:ws/invite-link/reset` (`team:manage`) → same | new code; the old one 404s |
| Join preview | **new** `GET /invitations/join/:code` (public, Throttle) → `{workspaceName, workspaceLogo, ownerName}` | `404` when disabled or unknown |
| Join | **new** `POST /invitations/join/:code` (Jwt) → `{workspaceId}` | joins as MEMBER (ACCEPTED invitation row with `invited_by = owner`); `409 SEAT_LIMIT_EXCEEDED`, `409 ALREADY_MEMBER`, `404` |
| Seats | existing `GET /billing/workspaces/:ws/usage` | unchanged |

**Schema (0091):** `workspace` gains `invite_link_code varchar(32) UNIQUE NULL`, `invite_link_enabled boolean NOT NULL DEFAULT false`. `workspace_invitations` gains `message text NULL`. Code format: workspace initials, `-`, then 10 Crockford base32 chars from `crypto.randomBytes` (for example `rw-7f2kq9m4xa`). **My call:** the design's 4-char code is guessable for a link that grants a seat. The join routes go in `open-routes.spec.ts`.

**Role label:** `roleLabel` maps GUEST to "Guest" (not "Viewer") everywhere, to match the design. **My call:** one name per role across the app.

**Phone (m3):** list card (avatar, name, role, chevron to a detail `Sheet` with the role select and Remove), pills without "Members", footer seat line, "Invite" in the topbar.

**FE:** `features/team/components/members/` — `members-view.tsx` (replaces `team-settings-view.tsx`), `member-filter-pills.tsx`, `members-table.tsx` (rewrite, split), `member-row.tsx`, `invite-row.tsx`, `member-row-menu.tsx`, `invite-row-menu.tsx`, `role-select.tsx` (restyle), `roles-matrix-dialog.tsx`, `invite-people-dialog.tsx` (rewrite of `invite-member-dialog.tsx`), `out-of-seats-banner.tsx`, `invite-link-section.tsx`, `remove-member-dialog.tsx`, `empty-members-art.tsx`, `member-sheet.tsx` (phone). `features/team/components/join/join-invite-link-view.tsx` + `src/pages/join.tsx` (route `/join/:code`, reuses the accept-invitation layout). Hooks: `use-invite-link.ts`, `use-resend-invite.ts`, `use-join-workspace.ts`. `MyInvitationsCard` moves to Profile's "Your workspaces" section as pending rows with Accept / Decline (**Builder call:** keep it if the plan finds no better home; it must not be lost).

### 5.8 Plan & billing on Lemon Squeezy (screens 7, 7a–7c, 7e–7g; F26–F34)

Owner-only page (`billing:manage`). `settings/plans` redirects to `settings/billing?plans=compare` (Compare plans is a dialog, so it is a search param, not a route).

**Card and invoices are handled in the provider's customer portal.** There is no in-app card form, no setup intent, and no "Stripe" in settings copy. The 7d Billing details dialog is replaced by the portal (the provider holds the billing name, address and tax id).

**Layout (F26):**
1. **Plan summary card:** icon tile, "{Plan} plan", "${price} a month · renews {date} · {Brand} •••• {last4}" (card part omitted when unknown), "Change plan" → Compare plans. Three meters: Channels "{used} / {limit}" · "Paused channels don't count"; Members · "Guests are free"; AI credits · "Resets {date}". Meter colour: `bg-primary`, amber (`warning`) from 90 %, red (`destructive`) only over the limit. Hovering the AI meter shows "AI credits · {used} of {limit}" and, when the usage log has feature data, a per-feature breakdown. The design's "See usage by person" link is dropped (**My call:** there is no page to link to).
2. **Add-ons** · "Extra room on top of your plan, billed with it.": one row per add-on that `GET /billing/workspaces/:ws/addons` offers for the plan, in this order: Extra channels, Extra seats, Extra AI credits, Extra workspaces. Each row: name, "${unit} per {unit} a month", stepper. Changing the stepper opens an inline confirm under the row: "{n} extra seats · +${x} a month" / "Prorated on your next invoice. Next invoice ${total}." / Cancel, Confirm. Nothing changes until Confirm. Confirm calls the existing add-on purchase or removal; `checkout_required` redirects to the hosted checkout. **My call:** the provider does not quote a proration amount in advance, so the design's "Prorated $6.13 today" figure is replaced by the sentence above.
3. **Payment:**
   - Row: card icon, "{Brand} •••• {last4}" (or "Card on file" when only the provider knows it), "Update card" → portal link with intent `update_payment_method` (opens in a new tab). Payment failed (7g): red "Declined" badge and a primary "Update card".
   - Row: "Billing details" / "{name} · {country} · {email}" (from the provider customer, cached) / "Edit" → portal link intent `portal`.
4. **Invoices** · "Next invoice: ${amount} on {date}.": the design's table (date, description, amount, status Paid/Failed, download icon). Rows come from **new** `GET /billing/workspaces/:ws/invoices/provider` (`billing:manage`), which for Lemon Squeezy calls `GET /v1/subscription-invoices?filter[subscription_id]=…` live (10-minute cache per subscription, newest first, 24 rows) and returns `{id, date, description, amountCents, currency, status, downloadUrl}` where `downloadUrl` is the invoice's `urls.invoice_url`; for Stripe it maps the existing synced invoices. Download opens `downloadUrl` in a new tab. Footer link "All invoices in the billing portal ↗" (portal intent). Owner ruling 2026-11-17: card and billing details go through the portal, the invoice list is shown in-app.
5. **Cancel plan** card: "You keep {Plan} until {date}, then move to Free." / "Cancel plan" → 7e. When already cancelled at period end: "Your plan ends on {date}." / "Resume plan" (existing resume path).

**Free plan (7f, F32):** star tile, "Free plan", "$0 · {channels} channels, {members} member, {credits} AI credits a month", primary "Upgrade" → Compare plans. Meters as above (amber at 90 %). Add-ons: one row "Extra channels, seats and AI credits" / "Come with paid plans. Upgrade to add them." / "Compare plans". Payment: "No card yet" / "Add one when you upgrade." (no button; a card exists only after checkout). Invoices: illustrated empty state "No invoices yet" / "They show here after your first payment." (`empty-invoices-art.tsx`). No Cancel card.

**Payment failed (7g, F33):** red banner "Your last payment of ${amount} failed. Update your card by {graceDate} to keep the {Plan} plan." with "Update card".

**Compare plans (7a, F27):** wide `Dialog`. Columns from `GET /billing/workspaces/:ws/plans`. First column note "Prices per account. Taxes added at checkout." (**My call:** billing is per account, not per workspace.) Monthly/Yearly toggle is shown only when the catalogue has yearly prices (it has none today, so it is hidden). Tags: "Current" on the current plan, "Popular" on the plan the catalogue flags (**Builder call:** use a `features.popular` flag if present, else the plan above the current one). CTAs: current → disabled "Current plan"; higher → primary "Switch to {Plan}" (from Free: hosted checkout via `checkout-session`; from paid: plan change); lower → outline "Downgrade" → preview → 7b or 7c. Feature rows come from plan fields and `features` (channels, members, workspaces, AI credits, Insights history, API access, white-label links, priority support); a row whose data the catalogue lacks is omitted. Footer "Upgrades start today and are prorated. Downgrades start at the next renewal." / Close.

**7b Switch confirm:** "{Plan} starts on {date}, when {Current} renews. Nothing is charged today." Comparison rows from the preview (old › new, usage sub-lines), total "From {date} · ${price} / month", Back / "Switch on {date}". Toast "Plan changes to {Plan} on {date}" with Undo (undo = plan change back to the current plan, which cancels the scheduled change; **Builder call:** confirm the plan-change service supports this for both providers; if not, no Undo).

**7c Over the limits:** blocker rows from the preview's `downgradeIssues` with "Open Channels ↗" / "Open Members"; "Rechecks when you come back." (refetch on window focus); primary disabled while any blocker remains.

**7e Cancel plan:** consequence list from a downgrade-to-FREE preview ("{n} of {m} channels pause (you pick which)", "{names} become guests", "AI credits drop to {n} a month", "Insights older than 30 days are hidden, not deleted" — each line only when it applies), reason radios (Too expensive, Missing something I need, Moving to another tool, Just taking a break), "Keep {Plan}" / destructive "Cancel plan". Cancels at period end.

**Endpoints:**
| Need | Endpoint |
|---|---|
| Everything on the page in one call | **new** `GET /billing/workspaces/:ws/overview` (`billing:manage`) |
| Portal link | **new** `POST /billing/workspaces/:ws/portal-link {intent: 'portal' \| 'update_payment_method'}` (`billing:manage`) → `{url}` |
| Plans, preview, change, checkout, add-ons, resume | existing routes (§5 of fe-inventory) |
| Cancel | existing `DELETE /billing/workspaces/:ws/subscription` — body adds `reason?: 'too_expensive' \| 'missing_feature' \| 'switching_tool' \| 'taking_break'`, stored on the `subscription_changes` row |

```ts
interface BillingOverview {
  provider: 'lemonsqueezy' | 'stripe';
  plan: { code: string; name: string; priceCents: number; interval: 'month' | 'year' };
  status: 'free' | 'trialing' | 'active' | 'past_due' | 'cancelled_at_period_end';
  renewsAt: string | null;
  endsAt: string | null;
  card: { brand: string | null; last4: string | null } | null;
  billingDetails: { name: string | null; email: string | null; country: string | null } | null;
  paymentFailure: { amountCents: number; currency: string; graceUntil: string } | null;
  nextInvoice: { amountCents: number; currency: string; date: string } | null;
  usage: {
    channels: { used: number; limit: number };
    members: { used: number; limit: number };
    aiCredits: { used: number; limit: number; resetsAt: string; byFeature: Array<{ feature: string; used: number }> | null };
  };
}
```

**BE:**
- `PaymentProviderAdapter` gains `createPortalLink(subscriptionId, intent): Promise<{url}>`. Lemon Squeezy: fetch the subscription and return `urls.customer_portal` or `urls.update_payment_method` (signed, short-lived; never cached). Stripe: a Billing Portal session.
- `billingDetails`: Lemon Squeezy customer object, cached 10 minutes per account.
- `paymentFailure.graceUntil`: **Builder call:** derive from the existing failed-payment/suspension logic (`failed_payments`, payment alerts); if the codebase has no grace rule, use first failure + the provider's dunning window and document it.
- `nextInvoice`: base plan + active add-ons from our catalogue at `renewsAt`.
- No schema change.

**FE removals:** `AddPaymentMethodDialog`, `StripeCardElement` usage, `utils/stripe-client.ts`, the `@stripe/*` imports in settings, `VITE_STRIPE_PUBLISHABLE_KEY` reads, the payment-methods list, `InvoiceDetailDialog` from settings (the new `invoices-section.tsx` replaces `InvoicesTable`), "Stripe" copy (`plans-shell.tsx`, invoice PDF error), and the dead files listed in fe-inventory §5. **Builder call:** remove the `@stripe/*` packages only if nothing outside settings imports them.

**FE:** `features/billing/components/plan-billing/` — `plan-billing-view.tsx`, `plan-summary-card.tsx`, `usage-meter.tsx`, `addons-section.tsx`, `addon-stepper-row.tsx`, `addon-confirm.tsx`, `payment-section.tsx`, `invoices-section.tsx`, `cancel-plan-card.tsx`, `cancel-plan-dialog.tsx`, `compare-plans-dialog.tsx`, `switch-plan-dialog.tsx`, `over-limits-dialog.tsx`, `payment-failed-banner.tsx`, `empty-invoices-art.tsx`. Hooks: `use-billing-overview.ts`, `use-portal-link.ts`. Hugeicons only.

### 5.9 Labels (screens 9, 9a–9c; F40–F44)

**Model — My call: a join table, not metadata strings.** be-gaps recommended keeping strings in `posts.metadata.labels` plus a catalogue. A join table is chosen instead because rename becomes a row update (no O(posts) rewrite racing composer saves), merge is one `UPDATE … ON CONFLICT DO NOTHING`, counts and "last used" are a `GROUP BY`, and the 10-second undo is a soft delete. The composer API keeps sending and receiving label **names**, so the composer contract does not change; the server translates.

**Schema (0092):**
```sql
CREATE TABLE workspace_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name varchar(40) NOT NULL,
  color text NOT NULL CHECK (color IN ('blue','orange','green','purple','pink','teal','red','grey')),
  description varchar(120),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX workspace_labels_name_uq ON workspace_labels (workspace_id, lower(name)) WHERE deleted_at IS NULL;
CREATE TABLE post_labels (
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES workspace_labels(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, label_id)
);
CREATE INDEX post_labels_label_idx ON post_labels (label_id);
```
Backfill in the same migration: one catalogue row per distinct (workspace, lower(name)) in `posts.metadata.labels` (first-seen spelling, colours assigned in palette order), then `post_labels` rows. `metadata.labels` is left in place but no longer read or written (removal is a follow-up).

**Semantics:**
- Post count = live `post_labels` rows on non-deleted posts. Last used = `max(post_labels.created_at)`; `null` → "Never" and count "—".
- Composer save/schedule/publish DTOs keep `labels?: string[]` ("absent keeps, present sets"). The server resolves names case-insensitively to active labels, **creates** missing ones (palette order colour; covers a race with a delete), and replaces the post's `post_labels` set.
- Composer reads (`draft-store.service.ts`) return label names from the join.
- Delete: sets `deleted_at` (rows in `post_labels` stay, hidden because every read joins on `deleted_at IS NULL`); returns `undoUntil` = now + 10 s (the server accepts restores for 60 s to absorb latency). A purge removes labels deleted more than 10 minutes ago (cascade deletes their `post_labels`). **Builder call:** run the purge from an existing cron or lazily on label writes; no new queue.
- Merge source → target: `INSERT INTO post_labels (post_id, target) SELECT post_id, target FROM post_labels WHERE label_id = source ON CONFLICT DO NOTHING`, then hard-delete the source, in one transaction. Insights "by label" (when built) groups by `label_id`, so history follows the target.
- A name clash on create/rename → `409 LABEL_NAME_TAKEN`.

**Endpoints** (controller `labels/workspaces/:workspaceId`, matching `brand-kit/workspaces/:id`):
| Method + path | Capability | Body | Response |
|---|---|---|---|
| `GET /labels/workspaces/:ws` | `posts:draft` | — | `{labels: Label[], total}`; sorted by name (**My call:** the design's order is not a rule; name order is stable) |
| `POST /labels/workspaces/:ws` | `labels:manage` | `{name (1–40, trimmed), color?, description? (≤120)}` | `Label` (201) |
| `PATCH /labels/workspaces/:ws/:labelId` | `labels:manage` | `{name?, color?, description? \| null}` | `Label` |
| `POST /labels/workspaces/:ws/:labelId/merge` | `labels:manage` | `{intoId}` | `{target: Label, moved: number}` |
| `DELETE /labels/workspaces/:ws/:labelId` | `labels:manage` | — | `{undoUntil}` |
| `POST /labels/workspaces/:ws/:labelId/restore` | `labels:manage` | — | `Label`; `410 UNDO_EXPIRED`; `409 LABEL_NAME_TAKEN` if the name was reused meanwhile |
| `GET /composer/workspaces/:ws/labels` | `posts:draft` | — | unchanged shape `{labels: string[]}`, now from the catalogue |
| Planner posts query | existing | adds `labels=<id,id>` | filters by `post_labels` |

`Label = {id, name, color, description, postCount, lastUsedAt}`.

**Screens:**
- **9 Labels (F40):** topbar "Labels" + primary "New label" (`labels:manage`). Intro "Labels group posts by theme for your team. They're never published." + "{n} labels". Table: Label (colour dot, name, description) · Posts · Last used · kebab (Edit, Change colour › 2×4 swatch grid, Merge into…, "See {n} posts in Planner ↗", separator, red Delete). Below: info line "Where labels show: the Labels row in the composer and Planner › Filter." (**copy change:** "Insights › Posts › By label" is dropped until that view exists).
- **9a New label / Edit label:** Name, Colour (8 swatches as a `ToggleGroup` with `aria-label`s), Description (optional, placeholder "What goes under this label"), Cancel / "Create label" (edit: "Save label").
- **9b Merge:** "Merge {name} into another label" · "Merge into" `Select` · info "The {n} posts labelled {name} move to {target}. Then {name} is deleted. Insights keep the history under {target}." · Cancel / Merge.
- **Delete:** confirm "Delete {name}?" / "It's removed from {n} posts. The posts stay." / Cancel, red Delete → toast "{name} deleted" with Undo and the ⌘Z hint (existing `undo-registry`), 10 s.
- **9c None yet (F43):** `empty-labels-art.tsx` (tag stack), "Sort posts by theme", "Labels like Promo or Behind the scenes let you filter the Planner and compare themes in Insights. Only your team sees them.", primary "New label". **Builder call:** the composer already has an `empty-labels-art.tsx` for its own empty state; per Rule 4a each surface draws its subject, so reuse it only if it is the same subject (a tag stack).
- **Composer Labels row (F44.4):** search "Find or create a label", checkbox rows with colour dots, "+ Create “{query}”" which POSTs the label (next unused palette colour) and checks it.
- **Planner filter:** a "Labels" group in the filter sheet (pills, colour dots), URL param `labels`. "See {n} posts in Planner" opens the Planner list view with `?labels={id}`.

**Colour tokens:** `src/index.css` gains `--label-blue` … `--label-grey` for light and dark, with `@theme` utilities (`bg-label-blue` …). Components never use palette classes.

**FE:** new `features/labels/` — `api/labels.api.ts`, `hooks/use-labels.ts`, `use-label-mutations.ts`, `schemas/label.schema.ts`, `constants/label-colours.ts`, `components/labels-view.tsx`, `labels-table.tsx`, `label-row.tsx`, `label-row-menu.tsx`, `label-dialog.tsx`, `colour-swatches.tsx`, `merge-label-dialog.tsx`, `delete-label-dialog.tsx`, `empty-labels-art.tsx`. Composer `labels-row.tsx` uses `useLabels`. Planner `lib/filters.ts` gains `labelIds`. `pages/settings/tags.tsx` becomes a redirect; `pages/settings/labels.tsx` is the thin page.

### 5.10 Account delete fix (screen 1c; F04)

**Endpoint:** `DELETE /users/me {confirmEmail: string}` (Jwt, Throttle 3/h per user) → `204`.
- `400 EMAIL_MISMATCH` unless `confirmEmail` equals the account email (case-insensitive, trimmed).
- `409 OWNS_WORKSPACES {workspaces: [{id, name}]}` while the user owns any workspace.
- Part B adds: when two-step is on, a `code` (TOTP or backup) is required.
- The old `DELETE /users/:id` becomes SUPER_ADMIN-only (admin tooling); the FE stops calling it.

**What happens, in one transaction:**
1. Cancel the account subscription at the provider immediately (no refund), if any is still active. Done before the transaction; a provider failure aborts with `502 BILLING_CANCEL_FAILED` and nothing is changed.
2. Every ACCEPTED or PENDING membership of the user → REMOVED (posts stay with the workspaces).
3. Anonymise the `users` row: `email = 'deleted+{id}@deleted.invalid'`, `name = null`, `password = null`, `google_sub = null`, `avatar_url = null`, `pending_email*` cleared, `preferences = '{}'`, `is_active = false`, `deleted_at = now()`, `sessions_revoked_at = now()`.
4. Delete personal rows: `known_devices`, notification preferences, planner preferences, inbox user settings, Maestro BYOK key and conversations owned by the user, `telegram_bindings`/bridge links. **Builder call:** the plan enumerates every table with a `user_id` FK and classifies each as delete, keep (workspace data), or anonymise.
5. Write an `admin_audit_logs`-style record (no PII beyond the user id).

Login, Google callback, refresh and `JwtStrategy` reject `deleted_at IS NOT NULL` (as they do for suspension). The old email is free to register again; a Google sign-in creates a fresh account.

**Schema (0090 + 0093):**
- 0090: `users.deleted_at timestamptz NULL`.
- 0093 `users_fk_set_null`: change the NO ACTION FKs to `ON DELETE SET NULL` — `usage_events.triggered_by_user_id`, `subscription_changes.changed_by_user_id`, `workspace_invitations.invited_by`, the Canva and drips `reviewed_by`/`performed_by` columns, and any other found by the plan's FK audit. The row is no longer deleted, but an admin purge must not 500 either. Also change `workspace.owner_id` from `ON DELETE CASCADE` to `ON DELETE RESTRICT`, so no path can silently delete owned workspaces again.

**Dialog (F04):** "Delete account" / "This deletes your login, profile and personal settings. It can't be undone." / one blocker row per owned workspace: avatar, name, "You're the owner. Delete it first." (**copy change**, no transfer), outline "Open General" (navigates to that workspace's General) / "Type your email to confirm" (placeholder = the email) / footer note "{workspace names} keep your posts." (only when the user is a member elsewhere) / Cancel, destructive "Delete account" enabled only with no blockers and an exact email match. On success: clear the in-memory token, toast "Your account is deleted", go to the sign-in page.

---

## 6. Save rule, feedback and states

### 6.1 Save rule (flow map, verbatim)
"Switches, selects and segmented controls save at once with an inline “Saved”. Text fields show a Save button only after a change. Sign-in, money and deleting always go through a dialog. No Save/Reset bar anywhere."

Implementation:
- `useInstantSave(mutation)`: optimistic update; on success shows `SavedIndicator` next to the control; on error rolls back and calls `toast.error(message, { error })` with a Try again action that repeats the same mutation.
- `SavedIndicator`: Hugeicons check + "Saved" in `text-success-text text-13`, fades after 2 s (`motion-safe:` transition; no fade under reduced motion, just removed). `aria-live="polite"`.
- `TextSaveField`: shadcn `Form` field (RHF + zod, one field per form). The Save button appears only while the value differs from the saved one; Enter saves; Escape restores. While saving: button spinner, input disabled. After saving: the button disappears and `SavedIndicator` shows. Validation errors show under the input.
- No toast for small saves. Toasts only for sign-in changes, undoable actions (logo remove, label delete, member remove, brand voice save), money, deletes and copies.
- Dialogs: sign-in (email, password, Google, 2FA), money (plan, add-ons, seats, cancel), deleting (account, workspace, label, member, leave).

### 6.2 Loading, error, empty, disabled
| State | Rule |
|---|---|
| Loading | Each page renders a `Skeleton` of its own sections (rows with label and control blocks), never a spinner page. Capability-gated routes show the skeleton while the role resolves. |
| Error (page load) | Inline `Alert` in the page body: what failed and a "Try again" button that refetches. |
| Error (action) | `toast.error(<sentence from errorReason>, { error })`; dialogs keep their input and show the server message inline when it is about a field (wrong password, name taken, wrong code). |
| Empty | Rule 4a: custom SVG per subject in the feature's `components/` (`empty-members-art.tsx`, `empty-labels-art.tsx`, `empty-invoices-art.tsx`; Part C `empty-brand-voice-art.tsx`), heading, one body line, CTA, centred with `m-auto`. |
| Disabled | Read-only views use disabled shadcn controls (opacity 50 %, `cursor-not-allowed`) plus the lock line; never hidden values. |
| Pending dialog | Primary button spinner, dismiss blocked only while the request is genuinely in flight (existing `dismiss-guard`). |
| Keyboard | Tab order follows the visual order; Enter submits dialogs; Escape closes; every icon button has an `aria-label`; tooltips on icon-only buttons. |
| Phone | Every page checked at 375 px: rows stack (label above control), tables become lists, dialogs become full-width, no horizontal scroll. Hover-only reveals get `pointer-coarse:opacity-100`. |

---

## 7. Part B — Security: sessions and two-step sign-in

Somewhat less detail than Part A; endpoints and schema are fixed.

### 7.1 Sessions (screen 2, "Where you're signed in")

**Schema (0094 `user_sessions`):**
```sql
CREATE TABLE user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_hash char(64),
  label varchar(120) NOT NULL,          -- "Chrome on Windows" (bowser)
  device_type text NOT NULL CHECK (device_type IN ('desktop','mobile','tablet','unknown')),
  ip varchar(45),
  country varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX user_sessions_user_live_idx ON user_sessions (user_id) WHERE revoked_at IS NULL;
```

**Behaviour:**
- Access and refresh tokens carry `sid`. Refresh JWT and cookie lifetime become 30 days; the row enforces idle expiry: each refresh rejects a revoked or expired row, sets `last_used_at = now()`, `expires_at = now() + 30 days`, and re-signs with the same `sid` (no single-use rotation, to avoid two-tab races).
- `JwtStrategy.validate` checks the session row (cached 30 s per `sid`) so a revoke takes effect within 30 s.
- Cookie max-age changes in one helper (`refresh-cookie.ts`); the hand-rolled `response.cookie` calls in `auth.controller.ts` move to it.
- Logout revokes its own session.
- Tokens issued before deploy (no `sid`): the refresh strategy creates a session row on their next refresh. **My call:** this avoids logging everyone out at deploy.
- Password change with "Log out of my other sessions" and "Log out of other sessions" revoke by `sid`; `sessionsRevokedAt` stays for "This wasn't me" and password reset.
- Members "Last active" switches to the latest `last_used_at`.

**Endpoints:**
- `GET /users/me/sessions` → `{sessions: [{id, label, deviceType, country, lastUsedAt, isCurrent}]}` (live only, current first).
- `DELETE /users/me/sessions/:id` → `204`; `400` for the current session (use log out).
- `POST /users/me/sessions/revoke-others` → `{revoked: number}`.

**FE (Security page):** "Where you're signed in" · "Sessions end after 30 days without use." · right "Log out of other sessions" (confirm "Log out of {n} other sessions?" / "{labels} will need to sign in again."; hidden when there are none). Rows: monitor or phone icon, label, "{country} · {Active now | relative}", "This device" badge or a ghost "Log out" (no confirm). Toast "Logged out of {n} sessions". "Active now" = last used within 5 minutes.

### 7.2 Two-step sign-in (screens 2b, 2c)

**Schema (0095 `two_factor`):**
- `users`: `totp_secret_enc text NULL`, `totp_pending_secret_enc text NULL`, `totp_enabled_at timestamptz NULL`, `totp_last_step bigint NULL`, `mfa_failures int NOT NULL DEFAULT 0`, `mfa_locked_until timestamptz NULL`.
- `user_backup_codes (id uuid pk, user_id fk cascade, code_hash char(64) NOT NULL, used_at timestamptz NULL, created_at timestamptz NOT NULL DEFAULT now())`, index `(user_id) WHERE used_at IS NULL`.
- `login_challenges (id uuid pk, user_id fk cascade, purpose text NOT NULL CHECK (purpose = 'mfa'), attempts int NOT NULL DEFAULT 0, device_hash char(64), expires_at timestamptz NOT NULL, consumed_at timestamptz NULL, created_at timestamptz NOT NULL DEFAULT now())`.
- `known_devices`: `mfa_trusted_until timestamptz NULL`.

**One session issuer (the core rule):**
- `SessionIssuer.issue(user, req, res, {via})` is the only code that calls `generateAccessToken` / `generateRefreshToken`, creates the `user_sessions` row and sets the cookie. Register, password login, Google callback, refresh, password change, 2FA enable, `/auth/2fa/verify`, the super-admin path, and any future path (bridge links, invite join) go through it.
- When `totp_enabled_at` is set and the device is not trusted, `issue` returns `{mfaRequired: true, challengeToken}` and mints nothing.
- **Guard test:** `session-issuer.guard.spec.ts` scans `src/**/*.ts` (excluding specs and the issuer itself) and fails if any other file references `generateAccessToken` or `generateRefreshToken`. Style of `every-workspace-route-guarded.spec.ts`.

**Challenge:**
- Signed JWT `{sub, cid, purpose: 'mfa'}`, 5-minute TTL, its own secret (or a purpose check on a dedicated key), bound to a `login_challenges` row and consumed once (`UPDATE … SET consumed_at = now() WHERE id = $cid AND consumed_at IS NULL AND expires_at > now() RETURNING …`).
- Password login answers `200 {mfaRequired: true, challengeToken}` (never 401, which the FE client would replay).
- Google callback redirects to `${FRONTEND_URL}/auth/two-step?challenge=…` (popup mode posts the challenge to the opener) and sets no cookie.
- Refresh does not re-challenge. Enabling 2FA revokes all other sessions.
- Password reset neither disables 2FA nor logs in.
- SUPER_ADMIN: the emailed challenge stays; when TOTP is on it is required after it. **My call:** stacking keeps the existing admin protection.

**Verification rules:**
- `otpauth` 9.6.0: SHA-1, 6 digits, 30 s, 160-bit secret from `crypto.randomBytes`, window ±1 step. Replay guard: `UPDATE users SET totp_last_step = $step WHERE id = $u AND (totp_last_step IS NULL OR totp_last_step < $step)`; zero rows = replay → reject.
- Attempts: 5 wrong codes kill the challenge (atomic `attempts = attempts + 1 … RETURNING`); 10 failures per hour per user lock second-factor attempts for 15 minutes (`mfa_locked_until`); `@Throttle` 10/15 min per IP on verify. The throttler is in-memory, so the DB counters are the real limit.
- After a correct password but a failed second factor, email the user (security class).
- Secret at rest: `common/utils/totp-secret.util.ts` wraps `encryption.util.ts` `encrypt`/`decrypt` strictly — `decryptStrict` throws on any value that is not `iv:tag:ct`, so a plaintext or tampered column never becomes a seed. The seed is never returned after enable.
- Backup codes: 10 codes, 8 Crockford base32 chars from `crypto.randomBytes`, shown as `XXXX-XXXX`; input normalised (uppercase, strip `-`/spaces, O→0, I/L→1); stored as HMAC-SHA256 with a server pepper (**Builder call:** env `MFA_CODE_PEPPER`, required at boot when 2FA is enabled); consumed with `UPDATE … SET used_at = now() WHERE user_id = $u AND code_hash = $h AND used_at IS NULL RETURNING id`. Email on use; warn in the UI when 2 or fewer remain.
- Trusted device: after a successful verify, the device's `known_devices.mfa_trusted_until = now() + 30 days` (the design says "each time you sign in on a new device"). Cleared on 2FA disable or re-enable, revoke-others and password change. The device cookie only skips the second factor together with a correct first factor.
- Recovery: no self-serve bypass. A SUPER_ADMIN reset endpoint (`POST /admin/users/:id/2fa/reset`, audited) for support. **Builder call:** the admin app UI for it is a follow-up; the endpoint ships in Part B.

**Endpoints:**
| Method + path | Auth | Body | Response |
|---|---|---|---|
| `GET /users/me/2fa` | Jwt | — | `{enabled, enabledAt, backupCodesRemaining}` |
| `POST /users/me/2fa/setup` | Jwt, Throttle | `{currentPassword?}` (required when `hasPassword`; Google-only accounts need a token `iat` within 10 minutes, else `403 REAUTH_REQUIRED` and the FE re-runs Google sign-in) | `{otpauthUrl, secretGrouped}` |
| `POST /users/me/2fa/enable` | Jwt | `{code}` | `{backupCodes: string[]}`; promotes the pending secret, revokes other sessions, re-issues this one, security email |
| `POST /users/me/2fa/backup-codes/regenerate` | Jwt | `{code}` | `{backupCodes: string[]}` |
| `POST /users/me/2fa/disable` | Jwt | `{code \| backupCode, currentPassword?}` | `204`; clears secret and codes, revokes other sessions, security email |
| `POST /auth/2fa/verify` | public, Throttle | `{challengeToken, code? \| backupCode?}` | the normal login response (tokens through the issuer) |

`PublicUser` gains `twoFactorEnabled`. Sensitive actions that require a code when 2FA is on: disable, regenerate, delete account.

**FE:**
- Security page "Two-step sign-in" · "Ask for a code from your phone each time you sign in on a new device.": Authenticator app row (Set up / "On since {date}" + Turn off), Backup codes row ("After setup" muted until on; then "{n} left" + "Regenerate codes").
- 2b dialog "Set up two-step sign-in · Step 1 of 2": `QRCodeSVG` of `otpauthUrl`, "Can't scan it? Type this key:" grouped key + "Copy key", `InputOTP` 6 slots, Cancel / "Turn on". Wrong code: inline error, boxes cleared.
- 2c dialog "Save your backup codes · Step 2 of 2": codes in a muted panel (`font-mono`), "Copy codes", "Download" (`schedura-backup-codes.txt`), checkbox "I've saved these codes" gating "Done" (laid out so the checkbox is not clipped). Then toast "Two-step sign-in is on" with the action "Regenerate codes" (owner copy change). The action opens the Regenerate dialog, which asks for a code and confirms, so a stray click cannot invalidate the codes just shown.
- Turn off dialog and Regenerate dialog: code (or backup code) entry.
- Login: `features/auth/components/two-step-form.tsx` + route `/auth/two-step` (shadcn `Form` + `InputOTP`, "Use a backup code instead" toggle), reached from the password login response and the Google redirect.
- Files: `features/account/components/security/two-step-section.tsx`, `setup-two-step-dialog.tsx`, `backup-codes-dialog.tsx`, `disable-two-step-dialog.tsx`, `regenerate-codes-dialog.tsx`, `sessions-section.tsx`, `session-row.tsx`, `revoke-others-dialog.tsx`; hooks `use-two-factor.ts`, `use-sessions.ts`.

---

## 8. Part C — Maestro & brand (screens 8, 8a–8c; F35–F39)

### 8.1 Brand voice

**Data constraint (binding):** never send Threads-API-sourced data to an LLM. Relearn reads only the workspace's own authored post text: `posts` rows created in Schedura for this workspace (content + per-platform content), status published, newest first, up to 120. Nothing fetched from a platform API (channel-page synced posts, inbox, analytics, snapshots) is read. A unit test asserts the relearn query touches only `posts`.

**Schema (0096 `brand_voice`):** `workspace_brand_profiles` gains:
- `tone text[] NOT NULL DEFAULT '{}'` (max 4 of Warm, Clear, Playful, Bold, Calm, Formal, Witty, Expert, Friendly; CHECK on values),
- `description text` (one sentence, ≤240),
- `words_use text[] NOT NULL DEFAULT '{}'`, `words_avoid text[] NOT NULL DEFAULT '{}'` (≤20 each, ≤40 chars),
- `emoji_level text NOT NULL DEFAULT 'few' CHECK (… IN ('none','few','lots'))`,
- `hashtags_mode text NOT NULL DEFAULT 'few' CHECK (… IN ('none','few','many','saved_groups'))` (few = 2–3, many = 5–8),
- `channel_tweaks jsonb NOT NULL DEFAULT '{}'` (platform → one line ≤120),
- `edited jsonb NOT NULL DEFAULT '{}'` (per-field edited flags: `{tone: true, wordsUse: true, …}`),
- `learned_post_count int NOT NULL DEFAULT 0`, `learned_platforms text[] NOT NULL DEFAULT '{}'`, `learned_at timestamptz`,
- `relearn_status text NOT NULL DEFAULT 'idle' CHECK (… IN ('idle','running','failed'))`, `relearn_progress int NOT NULL DEFAULT 0`,
- `version int NOT NULL DEFAULT 1`, `previous jsonb` (one-level snapshot for Undo).

Backfill: `tone` from existing `voice` chips that match the 9 tone values; `description` from `sells` (+ `audience`). The first-week flow keeps writing its own columns and also sets `description`/`tone` where unedited. **Builder call:** whether first-week drafting switches to read the new fields in Part C or a follow-up; Maestro's system prompt must read them in Part C, otherwise the controls are cosmetic.

**Endpoints** (under `/workspaces/:workspaceId/brand-voice`):
| Method + path | Capability | Body | Response |
|---|---|---|---|
| `GET …/brand-voice` | `settings:view` | — | `BrandVoice` (fields, `edited`, `status: 'not_learned' \| 'learned' \| 'running' \| 'failed'`, `progress`, `learnedPostCount`, `learnedPlatforms`, `version`, `eligiblePostCount`) |
| `PATCH …/brand-voice` | `brand:manage` | any subset of tone, description, wordsUse, wordsAvoid, emojiLevel, hashtagsMode, channelTweaks; plus `version` | `BrandVoice`; marks changed fields as edited; stores `previous`; `409 VERSION_CONFLICT` |
| `POST …/brand-voice/revert` | `brand:manage` | `{version}` | `BrandVoice` (restores `previous` incl. edited flags; `409` if a newer save happened) |
| `POST …/brand-voice/relearn` | `brand:manage` | — | `202 {status: 'running'}`; `409 ALREADY_RUNNING`; `422 NOT_ENOUGH_POSTS` (<10 authored published posts) |
| `POST …/brand-voice/preview` | `settings:view` | `{voice?: Partial<BrandVoiceFields>, seed?: number}` | `{text}`; stateless; uses unsaved values when given; charges AI credits; cached by hash(fields, seed) for 24 h; Throttle 20/h per user |

**Relearn job:** BullMQ queue `brand-voice`, job id `brand-relearn-{workspaceId}` (no colon). Reads the posts as above, asks the LLM for tone/words/emoji/hashtags/channel tweaks, then writes **only fields whose `edited` flag is false**, sets learned metadata, updates `relearn_progress` (0–100) as it goes. 3 attempts with backoff; final failure sets `failed`. Progress reaches the FE by polling `GET …/brand-voice` every 2 s while `running` (**Builder call:** use the existing realtime channel instead if it already carries per-workspace events).

**FE (F35–F39):**
- Header card: sparkle tile, "Maestro", "Writes, plans and replies in your brand voice. Uses AI credits from your plan.", right "{used} of {limit} credits used" (existing `GET /maestro/usage`).
- "Brand voice" · "Learned from {n} posts on {platforms}. Your edits are kept when it relearns." · "Relearn" (confirm "Relearn from recent posts?" / "Maestro reads your last {n} posts again. Tone and words you edited stay as they are."; disabled while running). Rows: Tone (chips + Edit), Words we use, Words we avoid, Emoji (`Select`: None / A few — "1–2 per post" / Lots), Hashtags (`Select`: None / 2–3 per post / 5–8 per post / "# Use saved groups — Library"), Channel tweaks (popover per connected network, one line each), and the "How Maestro would write it" strip (preview of the saved voice).
- 8a Edit brand voice dialog: tone chips (max 4; a fifth is disabled with a tooltip), description textarea, words use/avoid (comma-separated inputs), Preview panel with "Try another" (new seed), footer "Your edits stay when Maestro relearns." / Cancel / "Save voice". Toast "Brand voice saved" with Undo → revert.
- 8b Not learned yet: `empty-brand-voice-art.tsx`, "Your voice isn't learned yet", body "Maestro learns from posts you publish with Schedura. Publish 10, or describe your brand in a few words." (**copy change:** learning reads Schedura-authored posts only), primary "Connect a channel" when the workspace has no channels, otherwise "Create a post", secondary "Describe it instead" (opens 8a empty).
- 8c Relearning: banner in the card "Reading your last {n} posts · {p}%" / "You can leave this page."
- Read-only for members: no Edit/Relearn, selects disabled, preview still shown.

### 8.2 Brand kit row
Summary from `GET /brand-kit/workspaces/:id`: colour dots (up to 4), "Logo, colours and fonts" title, helper "{n} logo · {n} colours. Maestro uses them for images and watermarks." (fonts omitted; the brand kit has none). "Open in Library ↗" only when a Library brand-kit route exists. **My call:** the Library Brand Kit is parked; a link to nowhere is worse than none.

### 8.3 How Maestro works (workspace Maestro settings)

**Schema (0096):** `workspace.maestro_settings jsonb NOT NULL DEFAULT '{}'`, read with defaults `{askBeforeSend: true, webSearch: true, quality: 'balanced', labelAiPosts: false, whoCanUse: 'everyone_except_guests'}`.

**Endpoints:** `GET /workspaces/:ws/maestro-settings` (`settings:view`) and `PATCH /workspaces/:ws/maestro-settings` (`brand:manage`) with a partial body → full object.

**Enforcement (code, not prompt):**
- `whoCanUse`: a `MaestroAccessGuard` on every `/maestro/*` route that takes a workspace, on the Maestro bridge inbound handlers (Telegram/WhatsApp), and in the tool runtime. `nobody` → `403 MAESTRO_DISABLED`; `admins` → ADMIN+; `everyone_except_guests` → MEMBER+. The FE hides the Maestro entry points when the caller cannot use it (`/auth/me` workspace entries gain `maestroEnabledForMe`). Scope: the Maestro agent and bridge; composer caption assist and inbox reply assist are separate features and are not covered (**My call**, listed in §11).
- `askBeforeSend`: when true, every Maestro tool that schedules, publishes or sends goes through the existing confirm gate (`maestro/tools/confirm.ts`) regardless of the prompt. When false, those tools may act directly.
- `webSearch`: false removes the web-search tool from the registry for that workspace.
- `quality`: maps to the model tier and a credit multiplier (fast 0.5×, balanced 1×, best 2×). **Builder call:** the model ids per tier come from the existing Maestro model config.
- `labelAiPosts`: Maestro-created drafts carry `metadata.aiAuthored = true`; publishers set the platform's AI label where an API field exists (TikTok `is_aigc`; YouTube `containsSyntheticMedia`). Platforms without a field ignore it. **Builder call:** confirm each field in the publisher before shipping; the row's helper names only the platforms actually supported.

**FE:** rows per F35 with instant save; dropdowns per F39 (Quality: Fast — "Half the credits" / Balanced — "Default" / Best — "2× credits"; Who can use: Everyone except guests / Admins and owner only / Nobody — "Turns Maestro off").

**FE files:** `features/maestro-brand/` — `api/brand-voice.api.ts`, `api/maestro-settings.api.ts`, hooks `use-brand-voice.ts`, `use-relearn.ts`, `use-voice-preview.ts`, `use-maestro-settings.ts`, components `maestro-brand-view.tsx`, `maestro-header-card.tsx`, `brand-voice-section.tsx`, `tone-row.tsx`, `words-row.tsx`, `channel-tweaks-popover.tsx`, `voice-sample.tsx`, `edit-brand-voice-dialog.tsx`, `relearn-dialog.tsx`, `relearn-banner.tsx`, `empty-brand-voice-art.tsx`, `brand-kit-row.tsx`, `how-maestro-works-section.tsx`. Route `settings/maestro`.

---

## 9. Migrations

| File | Part | Contents |
|---|---|---|
| `0090_user_account_settings.sql` | A | `users`: `preferences jsonb`, `password_changed_at`, `notifications_paused_until`, `deleted_at`; planner week-start copy |
| `0091_workspace_settings.sql` | A | `workspace`: `approval_policy`, `shorten_links_default`, `utm_default`, `invite_link_code`, `invite_link_enabled`; `workspace_invitations.message` |
| `0092_workspace_labels.sql` | A | `workspace_labels`, `post_labels`, backfill (live posts only); their FKs added last, NOT VALID |
| `0093_users_fk_set_null.sql` | A | NO ACTION → SET NULL on user FKs; `workspace.owner_id` → RESTRICT; all added NOT VALID (no scan under ACCESS EXCLUSIVE) |
| `0094_user_sessions.sql` | B | `user_sessions` |
| `0095_two_factor.sql` | B | `users` TOTP columns, `user_backup_codes`, `login_challenges`, `known_devices.mfa_trusted_until` |
| `0096_brand_voice_maestro_settings.sql` | C | brand profile columns, `workspace.maestro_settings` |
| `0097_guest_seat_recount.sql` | A | recount `workspace_usage.members_count` as accepted non-guest members (guests use no seat); numbered after Part B/C's reserved files |
| `0098_users_fk_validate.sql` | A | `VALIDATE CONSTRAINT` for the FKs 0092 and 0093 add NOT VALID, in its own transaction (SHARE UPDATE EXCLUSIVE: blocks no writer) |

Rules: hand-written SQL with a Drizzle schema change in the same commit; `SET LOCAL lock_timeout` on `users`/`workspace`/`posts` ALTERs and an entry in `inbox-lock-timeout.spec.ts`; idempotent where practical (`IF NOT EXISTS`). If another branch lands a migration first, renumber at rebase (filenames order the run).

---

## 10. Testing

### Backend (each part)
- Jest unit specs next to the code for every new service and DTO (validation edges: enums, IANA zones, lengths, `null` logo, unknown preference keys rejected).
- Localhost Postgres `*.db.spec.ts` (`BEGIN … ROLLBACK`) for: the migrations applying on a copy of the schema; label backfill, merge (`ON CONFLICT`), soft delete and restore; account delete anonymisation and the FK changes; leave-workspace; deletion preview counts; approval policy on draft creation; time-zone move rescheduling; invite-link join with a full seat set; session idle expiry and revoke; backup-code single use; TOTP replay (`totp_last_step`); challenge single use and attempt counting.
- Route guard specs stay green: `every-workspace-route-guarded.spec.ts`, `open-routes.spec.ts`, `remaining-workspace-guards.spec.ts`, plus a new spec that every route in §4.3 has the listed capability.
- Part B: `session-issuer.guard.spec.ts` (§7.2); a spec per login path proving it returns `mfaRequired` for a 2FA user and mints nothing.
- Part C: the relearn source spec (only `posts`); `MaestroAccessGuard` spec for each `whoCanUse` × role; a spec that `askBeforeSend` gates each sending tool.
- Mutation discipline: each spec asserts the invariant (e.g. "a guest gets 403 on PATCH /workspace/:id"), so breaking the rule breaks a test.
- `npm run build` and `npm run lint` in the BE worktree. Local runs need Redis on 6379.

### Frontend (each part)
- Vitest for hooks and libs: `use-instant-save` rollback, `TextSaveField` dirty/escape, capability filtering of the nav, `SettingsCapabilityRoute` (loading → skeleton, denied → redirect), `ROLE_MATRIX` vs `CAPABILITY_MIN_ROLE`, `format-prefs` for every date/time format, preferences localStorage migration, pause option → timestamp maths (incl. week start), label colour tokens, invite-out-of-seats resume, BillingOverview → UI states (free, active, past_due, cancelled), no "Stripe" string in settings (a grep test).
- `tsc -b` (covers test files), `npm run lint`, and `npm run build` (the Vite build catches encoding problems that tsc does not).
- Browser check with Playwright against local BE (or the stateful mock harness), at 1440 px and 375 px, light and dark, for every screen in the part, signed in as owner, admin, member and guest. Record each screen as checked in the PR description. Empty states (6e, 7f invoices, 9c, 8b) and error states included.

---

## 11. Risks

| Risk | Part | Mitigation |
|---|---|---|
| A token-minting path left outside the issuer is a 2FA bypass | B | One issuer + the guard spec that fails on any other caller; per-path specs |
| Session check on every request adds DB load | B | 30 s cache per `sid`; index on live sessions |
| Display-timezone swap shows wrong times somewhere | A | Classify every `useWorkspaceTimezone` caller in the plan; Planner and composer browser checks around midnight in a far zone |
| Time-zone "Also move existing" reschedules many posts | A | Same path as the launched-slot edit; background job above ~500 posts; db spec |
| Label backfill on large `posts` | A | Set-based SQL in the migration with `lock_timeout`; measure row counts on prod before deploy (Railway console) |
| Account delete misses a personal table | A | FK audit enumerated in the plan; db spec deletes a user with rows in every table |
| `workspace.owner_id` RESTRICT breaks a path that relied on the cascade | A | Grep for user deletes; the only one is the account delete, now blocked by ownership |
| Approval policy changes who can publish | A | Default `none`; only drafts created after the change are affected |
| Provider portal links are short-lived | A | Fetched per click, never cached; opened in a new tab |
| Removing Stripe FE code breaks a non-settings import | A | Grep before deleting; build check |
| Brand-voice controls that Maestro ignores | C | Prompt builder spec asserts each field appears in the system prompt |
| LLM cost of previews | C | Cache by hash, throttle, charged to the workspace's credits |
| In-memory throttler with several replicas | B | DB counters are the real limits |

## 12. Settled while writing (overturnable)

These are **My call** items gathered in one place:
1. Labels use a join table (`post_labels`), not metadata strings (§5.9).
2. Theme colour swatches are removed (not in the design) (§5.4).
3. Language lists shipped locales only (§5.4).
4. UTM helper copy describes the real per-network `utm_source` (§5.6).
5. Workspace ID shows the full UUID (§5.6).
6. Invite link codes are 10 random chars, not 4 (§5.7).
7. GUEST is labelled "Guest" app-wide (§5.7).
8. Per-member channel access is out of scope (§2).
9. "Prices per account" in Compare plans; no proration figure in the add-on confirm; no card expiry; Billing details via the portal (§5.8).
10. Pause does not mute Slack routes (§5.5).
11. Who-can-use covers the Maestro agent and bridge, not caption assist or reply assist (§8.3).
12. Pre-deploy tokens get a session row on next refresh instead of a forced logout (§7.1).
13. Super-admin keeps the emailed challenge and adds TOTP on top (§7.2).
14. 8b empty-state copy says Maestro learns from posts published with Schedura (§8.1).

## 13. Open items left to the builder

Each has a default; the plan records the choice.
1. Planner and Library deep-link params for the ↗ items (§5.1).
2. Google "Connect" row: link mode exists or hide the row (§5.3).
3. Security email template for Google disconnect (§5.3).
4. `composerDefaultWhen` default = today's composer behaviour (§5.4).
5. Classification of `useWorkspaceTimezone` callers; list of date-format call sites (§5.4).
6. Slack "Change channel" from the routes API or link to Channels (§5.5).
7. Short-link domain in the Shorten links helper from `baseUrl` (§5.6).
8. Reschedule threshold for the time-zone move job (§5.6).
9. BullMQ job removal on workspace delete (§5.6).
10. Logo R2 orphan cleanup matches avatars (§5.6).
11. `MyInvitationsCard` placement (§5.7).
12. "Popular" tag source in Compare plans (§5.8).
13. Undo for a scheduled plan change, per provider (§5.8).
14. `graceUntil` derivation (§5.8).
15. Removing `@stripe/*` packages if unused elsewhere (§5.8).
16. Label purge trigger (§5.9); reuse of the composer's labels illustration (§5.9).
17. Personal-table classification for account delete (§5.10).
18. `MFA_CODE_PEPPER` env and the admin 2FA reset UI follow-up (§7.2).
19. First-week drafting reading the new brand-voice fields now or later (§8.1); realtime vs polling for relearn progress (§8.1).
20. Model ids per quality tier; AI-label fields per publisher (§8.3).

## 14. Owner questions (resolved 2026-11-17)

The owner delegated the remaining calls ("baki sb tumhari marzi k hisab se kr lo"):
- **Q1 — Connect channels for Members:** no change. The 6d dialog shows the server rule (`channels:manage` = MEMBER), so members keep connect/disconnect.
- **Q2 — AI credit packs:** not built. Add-ons shows the recurring `EXTRA_AI_TOKENS` stepper; the "Buy credits" popover is dropped.
- **Invoices:** shown in-app from the provider (§5.8 item 4); card and billing details go through the portal.
