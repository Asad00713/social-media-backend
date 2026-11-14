# Email Notifications (backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Schedura's email system:
- React Email templates for the Figma A–F set;
- one BullMQ `email` queue in front of Resend;
- per-user, per-workspace preferences with one-click unsubscribe;
- bounce suppression;
- the email/password-change security fixes;
- every template wired to the real trigger.

**Architecture:**
- Domain code calls `NotifyService.notify()`. It gates the in-app bell on preferences and enqueues a typed email job.
- The `email` worker re-checks the preference and suppression, renders the template (React Email, server-side) and calls `EmailService.deliver()`. That is the only function that talks to Resend.
- Codes and links a person is waiting on use `EmailOutboxService.sendNow()`: the same guard, render and deliver, without the queue.

**Tech Stack:**
- NestJS 11, Drizzle (hand-written SQL migrations), BullMQ 5, ioredis, Resend 6.7;
- `@react-email/components` 1.0.12 with `react` / `react-dom` 19;
- `svix` 1.84.1 and `bowser` ^2.15.0;
- Jest 30 with ts-jest.

**Spec:** `D:\My Documents\MyProjects\FullStackProjects\socialmedia-frontend-audience\docs\superpowers\specs\2026-11-14-email-notifications-design.md`. Read §3–§9 and Appendix A before any task. The template table in §4.2 and the copy deviations in §4.4 are binding.

**Figma copy:** `C:\Users\hp\AppData\Local\Temp\claude\b7bac591966eb68a\d4116103-65ee-4103-9aab-04bc02362fb0\scratchpad\email-figma\catalogue.md`. All subject, preheader, heading, body and button strings come verbatim from it, with `{placeholders}` filled from props. The PNGs in the same folder are the visual reference.

## Global Constraints

- **No external calls in tests:**
  - No LLM calls.
  - Tests never call live backends, live platform APIs, Resend or Gotenberg.
  - Fake every HTTP client: the Resend client, the Stripe client, GeoIP.
- **DB specs** (`*.db.spec.ts`):
  - They read `DATABASE_URL` from `../socialmedia-workspace/.env` and run with `PLANNER_DB_TESTS=1`. `assertLocalDatabase` aborts unless the host is localhost.
  - Use `describeDb` and `withRollbackDb` from `src/planner/testing/rollback-db.ts`, and seed helpers from `src/inbox/testing/inbox-db.ts`.
  - Always run them with `--runInBand`.
  - Command form: `DATABASE_URL="$(grep '^DATABASE_URL=' ../socialmedia-workspace/.env | cut -d= -f2-)" PLANNER_DB_TESTS=1 npx jest <path> --runInBand`.
- **BullMQ job ids** contain no `:`. Email job ids equal the idempotency key, which must match `^[A-Za-z0-9._-]{1,200}$`.
- **Typecheck** including test files with `npx tsc --noEmit -p tsconfig.json`. The baseline is **35 pre-existing errors in untouched files**. A task passes when the count is still 35 and none is in a file it touched.
- **Lint** touched files only: `npx eslint <files>`. Never run `npm run lint`.
- **Line endings:** keep each file's line endings. Existing `src/**/*.ts` files are CRLF, and new files match their folder's neighbours (check with `file -b`).
- **Migrations:**
  - Hand-written SQL in `drizzle/migrations/`, applied by filename at boot, in one transaction: no `BEGIN`/`COMMIT`, no `CONCURRENTLY`. Header comment in the 0066 style (WHY / SAFETY).
  - Numbers are reserved: **0068** preferences, **0069** suppressions, **0070** sessions revoked, **0071** pending email, **0072** known devices. 0067 belongs to another branch.
- **Env:**
  - Never read or edit `.env`.
  - `.env.example` gets commented lines only (Task 3 adds all of them).
- **Commits** end with:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```
- **Copy:**
  - Figma copy is verbatim.
  - No emoji in templates.
  - Every user-supplied string reaches HTML only through React text nodes, never `dangerouslySetInnerHTML`.
  - Subjects have `\r` and `\n` stripped.
- **Recipients come from the DB.** Never email an address taken from a request body, except the contact form sender (E1) and the change-email new address (A3).
- **Notifications never break the domain action.** Every trigger call site wraps the `NotifyService` / outbox call so a failure is logged and swallowed. `NotifyService.notify` itself never throws.

## Review Focus

1. **User-written text in templates.** Captions, names and workspace names containing `<script>`, `&` or quotes, an empty caption, or a 5 000-char caption must render escaped and readable: captions are truncated to 280 chars with `…`, and an empty caption renders `(No caption)`. Test owner: Task 1 (shared render spec) and Task 11 (post card).
2. **Link scanners prefetching email links.** A `GET` on an unsubscribe or security link must change nothing; only the `POST` acts. Test owners: Task 4 and Task 7.
3. **The recipient left the workspace between enqueue and send.** A delayed C1a flush or a queued B2 must not reach a removed member. `shouldSend` returns false for non-members. Test owners: Task 2 and Task 11.
4. **Resend failure classes.** 429 and 5xx retry; validation, 4xx and quota errors fail once. A retry after a lost response must not double-send, because the same `idempotencyKey` goes to Resend. Test owner: Task 3.
5. **Email change racing a signup.** The new address registers between request and confirm: confirm answers `409 EMAIL_TAKEN` without a 500 or a half-write. A wrong code 5 times locks the change. Test owner: Task 7.

---

## Dependency and parallelism map

```
T1 templates toolchain ─┐
                        ├─► T3 delivery pipeline ─┬─► T4 public endpoints (unsubscribe, webhook)
T2 preferences ─────────┘                         └─► T5 NotifyService + recipients
                                                         │
          (T1–T5 = foundations, run in order: T1‖T2, then T3, then T4‖T5)
                                                         ▼
   T6 password + sessions ─► T7 change email + security links
   T8 new-device   T9 lifecycle   T10 team   T11 post failures   T12 channels
   T13 approvals   T14 billing    T15 support + admin code       T16 restyles
                                                         ▼
                                              T17 completeness + cleanup
```

- **Independent, parallel-worktree safe after T5:** T6, T8, T9, T10, T11, T12, T13, T14, T15 and T16. T7 waits for T6.
- **Shared files to merge carefully:**
  - `users.schema.ts` (T6, T7);
  - `auth.service.ts` (T6, T8, T9);
  - `google-auth.service.ts` (T8, T9);
  - `src/drizzle/schema/index.ts` (T2, T3, T8);
  - `templates/security/index.ts` (T6, T7, T8, T15);
  - `templates/lifecycle/index.ts` (T9);
  - `templates/support/index.ts` (T15).

  Each group index is an array that tasks append to, so merges are one-line.

## File structure

```
src/email/
  email.module.ts                 (T3: queue, processor, outbox, suppression, tokens, controllers)
  email.service.ts                (T3: deliver(); sendEmail() becomes a wrapper; T17 deletes it)
  render/palette.ts               (T1) EMAIL_COLORS, EMAIL_FONT
  render/email-context.tsx        (T1) EmailContext {assetBaseUrl}
  render/render-email.tsx         (T1) renderEmail()
  render/components/*.tsx         (T1) layout + 11 blocks + text primitives + steps
  templates/types.ts              (T1) EmailTemplateDef, EmailCategory, FooterKind, FooterContext
  templates/template-ids.ts       (T1) TEMPLATE_IDS (29 ids)
  templates/define-template.ts    (T1) defineTemplate()
  templates/registry.ts           (T1) ALL_TEMPLATES, getTemplate()
  templates/<group>/index.ts      (T1 empty) security | team | publishing | billing | support | lifecycle | inbox | reports
  templates/<group>/<id>.tsx      (T6–T16) one file per template
  templates/templates.spec.ts     (T1) shared render contract over ALL_TEMPLATES
  preview/write-previews.ts       (T1) npm run email:preview
  links/app-links.ts              (T3) AppLinks
  links/format-when.ts            (T5) formatWhen()
  queue/email-job.ts              (T3) EmailJobData, EnqueueEmail
  queue/email-outbox.service.ts   (T3) enqueue(), sendNow()
  queue/email.processor.ts        (T3) worker
  queue/email-footer.service.ts   (T3) footer resolution
  email-once.service.ts           (T3) claim()
  suppression/*                   (T3 table+repo, T4 webhook)
  tokens/email-tokens.service.ts  (T4)
  public/email-public.controller.ts, public/email-pages.ts (T4; T7 adds security routes)
  batching/post-failure-batch.service.ts (T11)
src/notification-preferences/     (T2) catalogue, repository, service, controller, dto, module
src/notifications/notify.service.ts, recipients.service.ts (T5)
src/auth/devices/*                (T8)
src/users/account-security.*      (T6, T7)
src/billing/services/trial-ending.cron.ts (T14)
drizzle/migrations/0068…0072      (T2, T3, T6, T7, T8)
```

---

### Task 1: React Email toolchain, layout, blocks and preview

**Files:**
- Modify:
  - `package.json`: deps `react@19.2.0`, `react-dom@19.2.0`, `@react-email/components@1.0.12`; dev deps `@types/react@19`, `@types/react-dom@19`; script `"email:preview": "ts-node -r tsconfig-paths/register src/email/preview/write-previews.ts"`; jest `moduleFileExtensions` add `"tsx"`, `transform` key `"^.+\\.(t|j)sx?$"`.
  - `tsconfig.json`: `"jsx": "react-jsx"`.
  - `.gitignore`: `email-previews/`.
- Create:
  - `src/email/render/palette.ts`
  - `src/email/render/email-context.tsx`
  - `src/email/render/render-email.tsx`
  - `src/email/render/components/{layout,text,button,fallback-link,code-box,callout,post-card,post-row,quote,footer,detail-rows,people,steps}.tsx`
  - `src/email/templates/{types.ts,template-ids.ts,define-template.ts,registry.ts}`
  - `src/email/templates/{security,team,publishing,billing,support,lifecycle,inbox,reports}/index.ts`
  - `src/email/preview/write-previews.ts`
- Test:
  - `src/email/render/render-email.spec.ts`
  - `src/email/render/components/blocks.spec.ts`
  - `src/email/templates/templates.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
// palette.ts. Light design only (spec §4.1).
export const EMAIL_COLORS: {
  page: '#F3F4F6'; card: '#FFFFFF'; border: '#E5E7EB'; heading: '#111827'; body: '#374151';
  muted: '#6B7280'; primary: '#2563EB'; onPrimary: '#FFFFFF'; link: '#2563EB';
  infoBg: '#F3F4F6'; warnBg: '#FEF3C7'; dangerBg: '#FEE2E2'; dangerText: '#B91C1C'; codeBg: '#F9FAFB';
};
export const EMAIL_FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// types.ts
export type EmailCategory = 'security' | 'account' | 'billing' | 'team' | 'publishing' | 'inbox' | 'support' | 'lifecycle' | 'reports' | 'leads';
export type FooterKind = 'notification' | 'security' | 'account' | 'billing' | 'plain';
export interface FooterLink { label: string; href: string }
export interface FooterContext { reason: string; links: FooterLink[] }
export interface EmailTemplateDef<P> {
  id: TemplateId;
  category: EmailCategory;
  /** Preference key that can turn it off; null = mandatory. Typed as string here; T2 narrows it. */
  event: string | null;
  footer: FooterKind;
  subject(p: P): string;
  preheader(p: P): string;
  /** Overrides footer line 1 (e.g. A1, B1, C3, E1, F1, F2). */
  footerReason?(p: P): string;
  /** Extra links before "Help center" (E1 adds Status). */
  extraFooterLinks?: FooterLink[];
  Body(p: P): ReactElement;
  fixture: P;                          // Figma placeholder data
  variants?: Record<string, P>;        // extra previews (D3 kinds, C2 kinds, A5 via)
}
export type AnyTemplateDef = EmailTemplateDef<any>; // any: registry erases P; enqueue() is typed by the def
export interface RenderContext { assetBaseUrl: string; footer: FooterContext }

// template-ids.ts: all 29 ids from spec §4.2, as a const tuple
export const TEMPLATE_IDS = ['verify-email', 'reset-password', 'change-email-code', 'email-changed', 'password-changed', 'new-sign-in', 'workspace-invitation', 'invitation-accepted', 'removed-from-workspace', 'post-failed', 'posts-failed', 'channel-reconnect', 'approval-needed', 'post-approved', 'payment-failed', 'trial-ending', 'plan-changed', 'contact-received', 'welcome', 'inactive-reminder', 'pausing-soon', 'account-paused', 'deletion-warning', 'inbox-activity', 'drip-review', 'insight-report', 'lead-delivered', 'admin-login-code', 'contact-enquiry'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export function defineTemplate<P>(def: EmailTemplateDef<P>): EmailTemplateDef<P>;   // identity, for inference
export const ALL_TEMPLATES: AnyTemplateDef[];          // concat of the 8 group arrays
export function getTemplate(id: string): AnyTemplateDef; // throws Error(`Unknown email template "${id}"`)

export function renderEmail<P>(def: EmailTemplateDef<P>, props: P, ctx: RenderContext):
  Promise<{ subject: string; preheader: string; html: string; text: string }>;
```

- **Blocks** (props exactly):
  - `EmailLayout({preheader, footer: FooterContext, children})`
  - `Heading({children})`, `Paragraph({children, tone?: 'body' | 'muted'})`, `Strong`
  - `EmailButton({href, children, variant: 'primary' | 'secondary'})`
  - `FallbackLink({href})`
  - `CodeBox({code})`: shows `482 913` for `'482913'`.
  - `Callout({tone: 'info' | 'warning' | 'danger', children})`: icon image `icon-{tone}.png`.
  - `PostCard({platform, handle, when, caption, thumbnailUrl?: string | null})`
  - `PostRow({platform, handle, when, title, reason, thumbnailUrl?})`
  - `Quote({meta, children})`
  - `EmailFooter(FooterContext)`
  - `DetailRows({title?: string, rows: Array<{label: string; value: string}>})`
  - `People({from: {initials, name}, to: {initials, name}})`
  - `Steps({steps: Array<{title, body}>})`
- **Asset names**, as URLs `${assetBaseUrl}/<name>`:
  - `logo.png`;
  - `network-{platform}.png` for platform ∈ twitter, instagram, facebook, linkedin, threads, tiktok, youtube, bluesky, mastodon, pinterest, google_business, reddit, with an unknown platform falling back to `network-generic.png`;
  - `icon-info.png`, `icon-warning.png`, `icon-danger.png`.

  The FE plan ships exactly these files.
- **Caption rule:** in `PostCard`/`PostRow`, `caption.trim()` empty → `(No caption)`; longer than 280 chars → the first 279 chars + `…`.

Steps:

- [ ] **Step 1: Write failing tests**

```ts
// render-email.spec.ts. Uses a local test-only def, not the registry.
const def = defineTemplate<{ name: string; caption: string }>({
  id: 'welcome', category: 'lifecycle', event: null, footer: 'plain',
  subject: (p) => `Hi ${p.name}\r\nBcc: x@y.z`, preheader: () => 'Three things to do first.',
  Body: (p) => <><Heading>Hello {p.name}</Heading><PostCard platform="instagram" handle="@a" when="Today" caption={p.caption} /></>,
  fixture: { name: 'R', caption: 'x' },
});
const ctx = { assetBaseUrl: 'https://app.test/email', footer: { reason: 'Why line', links: [{ label: 'Privacy', href: 'https://s.test/privacy' }] } };
it('strips CR/LF from the subject', async () => expect((await renderEmail(def, def.fixture, ctx)).subject).toBe('Hi R Bcc: x@y.z'));
it('escapes user text in html and keeps a text part', async () => {
  const r = await renderEmail(def, { name: '<script>alert(1)</script>', caption: '<img src=x onerror=alert(1)>' }, ctx);
  expect(r.html).not.toContain('<script>alert(1)');
  expect(r.html).toContain('&lt;img src=x');
  expect(r.text).toContain('Hello <script>alert(1)</script>');   // plain text is not HTML
  expect(r.text).not.toMatch(/<(table|td|div|a )/);
});
it('puts the preheader and footer in the html', async () => {
  const r = await renderEmail(def, def.fixture, ctx);
  expect(r.html).toContain('Three things to do first.');
  expect(r.html).toContain('Why line'); expect(r.html).toContain('Schedura · schedura.ai');
  expect(r.html).toContain('https://app.test/email/logo.png');
});
// blocks.spec.ts
it('CodeBox groups six digits 3+3', ...expect(html).toContain('482 913'));
it('PostCard truncates captions over 280 chars and shows (No caption) for blank', ...);
it('PostCard uses network-generic.png for an unknown platform', ...);
it('EmailButton secondary has a border and no primary background', ...);
// templates.spec.ts. Contract over every registered template and variant (empty in T1, so it must pass vacuously and be a describe.each).
describe.each(ALL_TEMPLATES.flatMap((d) => [[d.id, d, d.fixture], ...Object.entries(d.variants ?? {}).map(([k, v]) => [`${d.id}--${k}`, d, v])]))('%s', (_n, def, props) => {
  it('renders subject, preheader, html and a text part', async () => {
    const r = await renderEmail(def, props, ctx);
    expect(r.subject.length).toBeGreaterThan(0); expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.html).toContain(def.preheader(props)); expect(r.text.length).toBeGreaterThan(20);
  });
  it('has exactly one or zero buttons', ...); // count of data-email-button attributes is 0 or 1
});
it('template ids are unique and known', () => { const ids = ALL_TEMPLATES.map((d) => d.id); expect(new Set(ids).size).toBe(ids.length); ids.forEach((id) => expect(TEMPLATE_IDS).toContain(id)); });
```

- [ ] **Step 2: Run, expect FAIL.** `npx jest src/email/render src/email/templates`. Expected: cannot find module.
- [ ] **Step 3: Install and configure.** Add the deps. The worktree's `npm ci` must have finished first; check `node_modules/.package-lock.json` exists. Then `npm install react@19.2.0 react-dom@19.2.0 @react-email/components@1.0.12 && npm install -D @types/react@19 @types/react-dom@19`. `@react-email/components` ships CJS (`dist/index.cjs`), so the CommonJS build works.
- [ ] **Step 4: Implement** the palette, context, blocks, layout, `renderEmail` and registry.
  - `renderEmail` uses `render(el)` and `render(el, { plainText: true })` from `@react-email/components`.
  - Each block uses `@react-email/components` primitives (`Section`, `Row`, `Column`, `Img`, `Button`, `Link`, `Text`, `Heading`, `Hr`, `Preview`) with inline styles from the palette.
  - `EmailButton` sets `data-email-button`.
  - Layout:
    - outer page `EMAIL_COLORS.page`;
    - 600 px container;
    - card with 12 px radius, 1 px border and 32 px padding (20 px under 480 px via a `<style>` media query on the card class);
    - logo row (`logo.png`, displayed at 120×22: the asset is 240×44);
    - footer outside the card, centred, 12 px, `muted`, three lines, with the links joined by ` · `.
- [ ] **Step 5: Preview script.** `write-previews.ts` renders every def's fixture and variants:
  - `assetBaseUrl` = `process.env.EMAIL_ASSET_BASE_URL ?? 'http://localhost:3001/email'`;
  - footer reason `Preview footer`;
  - writes `email-previews/<id>[--variant].html` plus `email-previews/index.html` linking them all.

  Run `npm run email:preview`. Expected: `index.html` written, listing 0 templates.
- [ ] **Step 6: Run the tests, expect PASS.** `npx jest src/email`. Then `npx nest build` succeeds and `dist/src/email/render/render-email.js` exists. Then `npx tsc --noEmit -p tsconfig.json`: still 35 errors.
- [ ] **Step 7: Commit** `feat(email): React Email toolchain, layout and the 11 Figma blocks`.

---

### Task 2: Notification preferences: table, catalogue, service, API

**Files:**
- Create:
  - `drizzle/migrations/0068_notification_preferences.sql`
  - `src/drizzle/schema/notification-preferences.schema.ts`
  - `src/notification-preferences/notification-events.ts`
  - `src/notification-preferences/notification-preferences.repository.ts`
  - `src/notification-preferences/notification-preferences.service.ts`
  - `src/notification-preferences/notification-preferences.controller.ts`
  - `src/notification-preferences/dto/update-notification-preferences.dto.ts`
  - `src/notification-preferences/notification-preferences.module.ts`
- Modify:
  - `src/drizzle/schema/index.ts` (export)
  - `src/app.module.ts` (import the module)
- Test:
  - `src/notification-preferences/notification-events.spec.ts`
  - `src/notification-preferences/notification-preferences.service.spec.ts`
  - `src/notification-preferences/notification-preferences.repository.db.spec.ts`
  - `src/notification-preferences/notification-preferences.controller.spec.ts`

**Interfaces:**
- Consumes: `WorkspaceRoleService.getRole(workspaceId, userId)` from `WorkspaceRoleModule`.
- Produces:

```ts
export const NOTIFICATION_EVENT_KEYS = ['post_failed','channel_health','drip_review','approval_request','post_approved','draft_ready','member_activity','inbox_assigned','inbox_mention','inbox_new_message','billing_alert','security_alert'] as const;
export type NotificationEventKey = (typeof NOTIFICATION_EVENT_KEYS)[number];
export type PreferenceEventKey = NotificationEventKey | 'inactivity_reminder';
export type PreferenceChannel = 'email' | 'app';
export interface ChannelRule { default: boolean; locked: boolean }
export interface NotificationEventDef { key: PreferenceEventKey; label: string; scope: 'workspace' | 'account'; email: ChannelRule | null; app: ChannelRule | null }
export const NOTIFICATION_EVENTS: Record<PreferenceEventKey, NotificationEventDef>;
export interface ChannelPreference { enabled: boolean; locked: boolean }
export interface NotificationPreferenceDto { event: NotificationEventKey; email: ChannelPreference | null; app: ChannelPreference | null }
export interface NotificationPreferencesResponse { workspaceId: string; events: NotificationPreferenceDto[] }
export interface PreferenceChange { event: NotificationEventKey; channel: PreferenceChannel; enabled: boolean }

class NotificationPreferencesService {
  shouldSend(userId: string, workspaceId: string | null, event: PreferenceEventKey, channel: PreferenceChannel): Promise<boolean>;
  list(userId: string, workspaceId: string): Promise<NotificationPreferencesResponse>;
  update(userId: string, workspaceId: string, changes: PreferenceChange[]): Promise<NotificationPreferencesResponse>;
  disableEmail(userId: string, workspaceId: string | null, event: PreferenceEventKey): Promise<void>;
}
```

**Values.** Copy the catalogue from spec §5.2, in that order.
- Labels:
  - post_failed `Post failed`
  - channel_health `Channel disconnected`
  - drip_review `Drip post to review`
  - approval_request `Approval requested`
  - post_approved `Post approved`
  - draft_ready `Draft ready`
  - member_activity `Member joined`
  - inbox_assigned `Conversation assigned`
  - inbox_mention `Mentioned in a note`
  - inbox_new_message `New inbox message`
  - billing_alert `Billing`
  - security_alert `Security`
  - inactivity_reminder `Inactivity reminders` (scope `account`)
- Error bodies are Appendix A.1 verbatim, built as `new BadRequestException({statusCode:400,error:'Bad Request',code,message})`.

**Migration 0068** creates the table exactly as in spec §5.1, plus the two partial unique indexes:
- `notification_preferences_ws_uq`;
- `notification_preferences_account_uq`;

and an index `(user_id)`. Timestamps are `timestamptz`.

Steps:

- [ ] **Step 1: Failing tests**

```ts
// notification-events.spec.ts
it('keeps the FE ids and defaults that overlap', () => {
  expect(NOTIFICATION_EVENTS.post_failed).toMatchObject({ email: { default: true, locked: false }, app: { default: true, locked: true } });
  expect(NOTIFICATION_EVENTS.member_activity.email).toEqual({ default: false, locked: false });
  expect(NOTIFICATION_EVENTS.security_alert.email).toEqual({ default: true, locked: true });
  expect(NOTIFICATION_EVENTS.billing_alert.app).toEqual({ default: true, locked: false });
  expect(NOTIFICATION_EVENTS.drip_review.app).toBeNull(); expect(NOTIFICATION_EVENTS.draft_ready.email).toBeNull();
  expect(NOTIFICATION_EVENTS.inactivity_reminder.scope).toBe('account');
});
// service.spec.ts. Fake repository + fake WorkspaceRoleService.
it('locked channel is always true even with an off row', ...shouldSend(u, ws, 'post_failed', 'app') === true);
it('unavailable channel is false', ...shouldSend(u, ws, 'draft_ready', 'email') === false);
it('non-member gets false (removed after enqueue)', ...getRole → null ⇒ false, repo not read);
it('override row wins over default', ...member_activity email row enabled=true ⇒ true);
it('default when no row', ...approval_request email ⇒ true; member_activity email ⇒ false);
it('account-scope event ignores workspace membership', ...shouldSend(u, null, 'inactivity_reminder', 'email') === true);
it('update rejects a locked channel with NOTIFICATION_CHANNEL_LOCKED', ...);
it('update rejects an unavailable channel with NOTIFICATION_CHANNEL_UNAVAILABLE', ...);
it('list returns every workspace-scope event in catalogue order, with nulls for unavailable channels', ...12 entries, no inactivity_reminder);
// repository.db.spec.ts (describeDb, withRollbackDb(['0068_notification_preferences.sql'], …))
it('upsert twice keeps one row per (user, ws, event, channel)', ...);
it('account-level rows (workspace_id NULL) upsert on the second partial index', ...);
it('rejects channel "sms" (CHECK)', ...);
it('cascades on workspace delete', ...);
// controller.spec.ts
it('routes are workspace-guarded with team:view', ...); // reflect metadata like other controller specs
```

- [ ] **Step 2: Run, expect FAIL.**
  - `npx jest src/notification-preferences`.
  - Then the DB spec with the DB command from Global Constraints.
- [ ] **Step 3: Implement.**
  - Repository:
    - `findForUser(userId, workspaceId | null)`;
    - `upsert(userId, workspaceId | null, event, channel, enabled)`, using Drizzle `onConflictDoUpdate({ target, targetWhere })` with the matching partial index predicate.
  - Controller: `@Controller('workspaces/:workspaceId/notification-preferences')`, `@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)`, `@RequireCapability('team:view')` on `@Get()` and `@Put()`, `ParseUUIDPipe` on the id.
  - DTO: `changes` is `@IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({each:true}) @Type(() => ChangeDto)`, with `event @IsIn(NOTIFICATION_EVENT_KEYS)`, `channel @IsIn(['email','app'])` and `enabled @IsBoolean()`.
  - The module exports the service.
- [ ] **Step 4: Run all of Step 2 plus `npx jest src/workspace-members/every-workspace-route-guarded.spec.ts`. Expect PASS.**
- [ ] **Step 5: Typecheck (35), lint the touched files, commit** `feat(notifications): per-workspace notification preferences API`.

---

### Task 3: Delivery pipeline: deliver(), the email queue, outbox, worker, suppression table

**Files:**
- Create:
  - `drizzle/migrations/0069_email_suppressions.sql`
  - `src/drizzle/schema/email-suppressions.schema.ts`
  - `src/email/suppression/email-suppression.repository.ts`
  - `src/email/links/app-links.ts`
  - `src/email/email-once.service.ts`
  - `src/email/queue/{email-job.ts,email-outbox.service.ts,email.processor.ts,email-footer.service.ts}`
- Modify:
  - `src/email/email.service.ts`
  - `src/email/email.module.ts`
  - `src/queue/queue.module.ts` (`EMAIL: 'email'` + `registerQueue`)
  - `src/drizzle/schema/index.ts`
  - `.env.example`
- Test:
  - `src/email/email.service.spec.ts` (extend)
  - `src/email/queue/email-outbox.service.spec.ts`
  - `src/email/queue/email.processor.spec.ts`
  - `src/email/queue/email-footer.service.spec.ts`
  - `src/email/links/app-links.spec.ts`
  - `src/email/email-once.service.spec.ts`
  - `src/email/suppression/email-suppression.repository.db.spec.ts`

**Interfaces:**
- Consumes:
  - T1: `renderEmail`, `getTemplate`, `EmailTemplateDef`, `FooterContext`;
  - T2: `NotificationPreferencesService.shouldSend`, `NOTIFICATION_EVENTS`.
- Produces:

```ts
// email.service.ts
export interface OutgoingEmail { to: string; subject: string; html: string; text: string; replyTo?: string; headers?: Record<string,string>; attachments?: { filename: string; content: Buffer }[] }
export interface DeliverOptions { idempotencyKey: string; tags: { category: string; template: string } }
export interface EmailResult { success: boolean; messageId?: string; error?: string; retryable?: boolean }
deliver(msg: OutgoingEmail, opts: DeliverOptions): Promise<EmailResult>;
sendEmail(...)  // unchanged signature; now builds key `legacy.${randomUUID()}`, tags {category:'legacy',template:'legacy'} and calls deliver(). Deleted in T17.

// email-job.ts
export interface EmailRecipient { email: string; userId: string | null }
export interface EnqueueEmail<P> {
  template: EmailTemplateDef<P>; props: P; to: EmailRecipient;
  workspaceId: string | null; idempotencyKey: string; replyTo?: string; delayMs?: number;
}
export interface EmailJobData { template: TemplateId; props: unknown; to: EmailRecipient; workspaceId: string | null; idempotencyKey: string; replyTo?: string }
export const EMAIL_JOB_SEND = 'send';
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{1,200}$/;

// email-outbox.service.ts
enqueue<P>(input: EnqueueEmail<P>): Promise<void>;          // throws on a bad key; jobId = key
sendNow<P>(input: Omit<EnqueueEmail<P>, 'delayMs'>): Promise<EmailResult>; // same guard+render+deliver, inline; catches process() errors ⇒ {success:false, error}
/** Shared by sendNow and the worker. */
process(data: EmailJobData): Promise<'sent' | 'skipped:pref' | 'skipped:suppressed'>; // throws RetryableEmailError / UnrecoverableError

// email-footer.service.ts
build(def: AnyTemplateDef, props: unknown, to: EmailRecipient, workspaceId: string | null): Promise<FooterContext>;

// app-links.ts (@Injectable)
frontend(path: string): string; workspace(ws: string, path: string): string; planner(ws: string, postId?: string): string;
channels(ws: string): string; billing(ws: string): string; members(ws: string): string; notifications(ws: string): string;
inbox(ws: string, conversationId: string): string; invite(token: string): string; resetPassword(token: string): string;
api(path: string): string; assetBase(): string; help(): string; billingHelp(): string; privacy(): string; status(): string; supportEmail(): string;

// email-once.service.ts
claim(key: string, ttlSeconds: number): Promise<boolean>;   // SET email-once:{key} 1 NX EX; Redis error → true + warn

// email-suppression.repository.ts
isSuppressed(email: string): Promise<boolean>; suppress(email: string, reason: 'bounced'|'complained', resendEmailId: string | null): Promise<void>;
```

**Values:**
- **AppLinks env:**

  | Env | Default | Notes |
  |---|---|---|
  | `FRONTEND_URL` | `http://localhost:3001` | |
  | `API_PUBLIC_URL` → `APP_URL` | `http://localhost:3000` | |
  | `MARKETING_URL` | `https://schedura.ai` | help = `/help`, billingHelp = `/help/billing`, privacy = `/privacy`, status = `/status` |
  | `EMAIL_ASSET_BASE_URL` | `${FRONTEND_URL}/email` | |
  | `SUPPORT_EMAIL` | `support@schedura.ai` | |

  Strip trailing `/` from every base.
- **Footer rules:** spec §4.1 table, verbatim.
  - `notification`: `You get this because ${NOTIFICATION_EVENTS[event].label} → Email is on for ${workspaceName}.` + links `Manage notifications` (`notifications(ws)`), `Help center`, `Privacy`.
  - `security`: `Security emails can't be turned off.`
  - `account`: `Account emails can't be turned off.`
  - `billing`: `Billing emails go to workspace owners and can't be turned off.`, with links `Billing help · Privacy`.
  - `plain`: `def.footerReason(props)`, links `Help center · Privacy`.
  - `def.footerReason` overrides line 1 for every kind.
  - The workspace name comes from one `select name from workspace where id`.
- **Queue:** `@Processor(QUEUES.EMAIL, { concurrency: 4, limiter: { max: 8, duration: 1000 } })`. Jobs are added with `{ jobId: key, attempts: 5, backoff: { type: 'exponential', delay: 2000 }, delay: delayMs }`.
- **Retryable** Resend `error.name` ∈ `rate_limit_exceeded`, `concurrent_idempotent_requests`, `application_error`, `internal_server_error`, or `statusCode >= 500`, or `statusCode === null` (a network error). Everything else is unrecoverable (`UnrecoverableError` from `bullmq`).
- **Guard order** in `process`:
  1. `def = getTemplate(data.template)`;
  2. if `def.event` and `to.userId`: `shouldSend(to.userId, ws, def.event as PreferenceEventKey, 'email')` is false → `skipped:pref` (T17 asserts every `def.event` is a catalogue key);
  3. if `def.footer === 'notification'` or `def.category === 'lifecycle'`, and `isSuppressed(to.email)` → `skipped:suppressed`;
  4. footer;
  5. render;
  6. deliver.
- **deliver:**
  - from `RESEND_FROM_EMAIL` (default `Schedura <noreply@schedura.ai>`);
  - `replyTo` = msg.replyTo ?? `RESEND_REPLY_TO` (omitted if neither);
  - `tags` as two name/value pairs;
  - `{ idempotencyKey }` as the second argument of `resend.emails.send`.
- **Migration 0069:** `email_suppressions(email varchar(255) PRIMARY KEY CHECK (email = lower(email)), reason varchar(16) NOT NULL CHECK (reason IN ('bounced','complained')), resend_email_id varchar(64), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`.
- **`.env.example`** gets commented lines with one-line explanations:
  - `# RESEND_REPLY_TO=`
  - `# SUPPORT_EMAIL=support@schedura.ai`
  - `# RESEND_WEBHOOK_SECRET=whsec_...`
  - `# MARKETING_URL=https://schedura.ai`
  - `# EMAIL_ASSET_BASE_URL=https://app.schedura.ai/email`

Steps:

- [ ] **Step 1: Failing tests** (a fake Resend: `{ emails: { send: jest.fn() } }` injected by replacing the private client after construction, as the existing `email.service.spec.ts` does)

```ts
it('deliver passes idempotencyKey and tags', async () => { await svc.deliver(msg, { idempotencyKey: 'welcome.u1', tags: { category: 'lifecycle', template: 'welcome' } });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ tags: [{ name: 'category', value: 'lifecycle' }, { name: 'template', value: 'welcome' }] }), { idempotencyKey: 'welcome.u1' }); });
it('deliver marks rate_limit_exceeded retryable and validation_error not', ...);
it('deliver uses RESEND_REPLY_TO unless the message has replyTo', ...);
it('FRONTEND_URL defaults to http://localhost:3001', () => expect(new AppLinks(cfg({})).frontend('/x')).toBe('http://localhost:3001/x'));
it('enqueue rejects a key with ":"', () => expect(outbox.enqueue({ ...input, idempotencyKey: 'a:b' })).rejects.toThrow(/idempotency key/));
it('enqueue adds jobId = key, attempts 5, exponential 2000, delay', ...);
it('process skips on preference off without rendering', ...→ 'skipped:pref', deliver not called);
it('process skips suppressed recipients for notification mail but still sends security mail', ...);
it('process throws UnrecoverableError on a validation_error and a plain Error on rate_limit_exceeded', ...);
it('a BullMQ retry re-sends with the same idempotencyKey', ...two process() calls ⇒ both deliver calls carry the same key);
it('footer: notification kind names the event label and workspace and links Manage notifications', ...
  expect(f.reason).toBe('You get this because Post failed → Email is on for Rehman Workspace.'); expect(f.links[0]).toEqual({ label: 'Manage notifications', href: 'http://localhost:3001/w/ws1/settings/notifications' }));
it('footer: billing kind links Billing help · Privacy', ...);
it('claim returns true then false, and true when Redis throws', ...);
// db spec
it('suppress lowercases and upserts; isSuppressed matches case-insensitively', ...);
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - `EmailModule` imports `QueueModule`, `NotificationPreferencesModule` and `ConfigModule`.
  - It provides `RedisClientProvider` (import the provider object from `src/channels/analytics/redis-client.provider.ts`; do not import that module), and exports `EmailService`, `EmailOutboxService`, `AppLinks` and `EmailOnceService`.
  - The processor `process(job)` switches on `job.name`. `send` → `outbox.process(job.data)`. T11 adds `post-failed-flush`.
- [ ] **Step 4: Run, expect PASS.** `npx jest src/email src/queue`, then the DB spec.
- [ ] **Step 5: Typecheck (35), lint, commit** `feat(email): one sending path, email queue, suppression table`.

---

### Task 4: Public email endpoints: unsubscribe, List-Unsubscribe, Resend webhook

**Files:**
- Create:
  - `src/email/tokens/email-tokens.service.ts`
  - `src/email/public/email-public.controller.ts`
  - `src/email/public/email-pages.ts`
  - `src/email/webhooks/resend-webhook.controller.ts`
- Modify:
  - `src/email/queue/email-outbox.service.ts` (add the headers)
  - `src/email/email.module.ts`
  - `package.json` (`svix@1.84.1`)
- Test:
  - `src/email/tokens/email-tokens.service.spec.ts`
  - `src/email/public/email-public.controller.spec.ts`
  - `src/email/webhooks/resend-webhook.controller.spec.ts`
  - extend `email-outbox.service.spec.ts`

**Interfaces:**
- Consumes:
  - T2 `disableEmail`, `NOTIFICATION_EVENTS`;
  - T3 `AppLinks`, `EmailSuppressionRepository`, `process()`.
- Produces:

```ts
// email-tokens.service.ts. Report-token pattern (src/insights/reports/report-tokens.service.ts): derived HMAC key, own audience, HS256 pinned.
unsubscribeToken(p: { uid: string; ws: string | null; ev: PreferenceEventKey }): string;   // label 'email-prefs-tokens', aud 'email-unsubscribe', no exp
verifyUnsubscribe(t: string): { uid: string; ws: string | null; ev: PreferenceEventKey } | null;
securityToken(p: { uid: string; act: 'revert_email' | 'not_me'; from?: string; to?: string }): string; // label 'email-security-tokens', aud 'email-security', exp 7d
verifySecurity(t: string): { uid: string; act: 'revert_email' | 'not_me'; from?: string; to?: string } | null;
// email-pages.ts. Plain HTML strings, the same look as report-pages.ts, every value through escapeHtml from insights/reports/lib/escape-html.ts.
confirmPage(o: { title: string; body: string; action: string; button: string }): string;
donePage(o: { title: string; body: string; link?: { href: string; label: string } }): string;
invalidLinkPage(): string;
```

**Behaviour:**
- Routes in `EmailPublicController`, `@Controller('email')`, `@SkipLaunchGate()`:
  - `GET unsubscribe/:token` shows the confirm page. Title `Stop these emails?`, body `Stop "${label}" emails for ${workspaceName}?` (or `…for your account?` when `ws` is null), button `Stop emails`.
  - `POST unsubscribe/:token` with `@HttpCode(200)`: reads no body, calls `disableEmail`, then shows the done page. Title `You're unsubscribed`, body `You won't get "${label}" emails for ${workspaceName} any more.`, link `Manage notifications` → `notifications(ws)` (omitted when ws is null).
  - A bad token always gets the 404 `invalidLinkPage()`.
- Throttle and headers copy `reports-public.controller.ts` exactly:
  - `ReportsPublicThrottlerGuard`, 10/min;
  - POST tracked per token with `getTracker: (req) => 'email-unsub:' + req.params.token`;
  - `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`, and the same CSP.
- `EmailOutboxService.process` adds both headers when:
  - `def.footer === 'notification'`, or `def.event === 'inactivity_reminder'`;
  - and `to.userId` is set.

  The headers are:
  - `List-Unsubscribe: <${links.api('/email/unsubscribe/' + token)}>`;
  - `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
- `ResendWebhookController`: `@Controller('email/webhooks')`, `@Post('resend')`, `@HttpCode(200)`, `@SkipLaunchGate()`, no JWT guard. Logic:
  1. If `RESEND_WEBHOOK_SECRET` is unset, return 503.
  2. Verify with `new Webhook(secret).verify(req.rawBody.toString('utf8'), { 'svix-id', 'svix-timestamp', 'svix-signature' })` from `svix`. On failure, return 400.
  3. `email.bounced` with `data.bounce?.type !== 'Transient'` → `suppress(each of data.to, 'bounced', data.email_id)`.
  4. `email.complained` → `suppress(..., 'complained', ...)`.
  5. Anything else → 200 `{ignored: true}`.

Steps:

- [ ] **Step 1: Failing tests**

```ts
it('unsubscribe token round-trips and a login access token (no audience) does not verify', ...);
it('a report-unsubscribe token does not verify as an email-unsubscribe token', ...);
it('security token expires after 7 days', ...jest.useFakeTimers / sign with exp in the past ⇒ null);
it('GET unsubscribe does not call disableEmail (scanner prefetch)', ...);
it('POST unsubscribe disables exactly (uid, ws, ev) email and answers 200 with the done page', ...);
it('POST with a bad token is 404 and changes nothing', ...);
it('notification mail carries List-Unsubscribe and List-Unsubscribe-Post; security mail carries neither', ...);
it('webhook: bad signature → 400, no suppression', ...); // sign test payloads with new Webhook(secret).sign(id, date, body)
it('webhook: email.bounced Permanent suppresses each recipient; Transient does not', ...);
it('webhook: email.complained suppresses', ...);
it('webhook: no secret → 503', ...);
```

- [ ] **Step 2: Run, expect FAIL.** `npx jest src/email`.
- [ ] **Step 3: Implement** and `npm install svix@1.84.1`.
- [ ] **Step 4: Run, expect PASS.** Also `npx jest src/workspace-members/every-workspace-route-guarded.spec.ts src/auth/launch-gate-routes.spec.ts`. If the launch-gate spec lists open routes, add the three new routes to its allow-list the way the report routes are listed.
- [ ] **Step 5: Typecheck (35), lint, commit** `feat(email): one-click unsubscribe, security tokens, Resend bounce webhook`.

---

### Task 5: NotifyService, RecipientsService, formatWhen

**Files:**
- Create:
  - `src/notifications/notify.service.ts`
  - `src/notifications/recipients.service.ts`
  - `src/email/links/format-when.ts`
- Modify: `src/notifications/notifications.module.ts` (import `EmailModule` and `NotificationPreferencesModule`; provide and export both services)
- Test:
  - `src/notifications/notify.service.spec.ts`
  - `src/notifications/recipients.service.db.spec.ts`
  - `src/email/links/format-when.spec.ts`

**Interfaces:**
- Consumes: T2 `shouldSend`; T3 `EmailOutboxService.enqueue`, `EnqueueEmail`.
- Produces:

```ts
export interface Recipient { id: string; email: string; name: string | null }
class RecipientsService {
  user(userId: string): Promise<Recipient | null>;
  owner(workspaceId: string): Promise<Recipient | null>;
  admins(workspaceId: string): Promise<Recipient[]>;          // owner + ACCEPTED ADMIN, deduped
  workspace(workspaceId: string): Promise<{ id: string; name: string; timezone: string } | null>;
  userTimezone(userId: string): Promise<string>;                // tz of users.lastAccessedWorkspaceId, else 'UTC'
  displayName(r: { name: string | null; email: string }): string; // name || email
}
export interface NotifyInput<P> {
  userId: string; workspaceId: string | null; event: PreferenceEventKey | null;
  bell?: () => Promise<unknown>;
  email?: Omit<EnqueueEmail<P>, 'to' | 'workspaceId'> & { to?: string };  // to defaults to the user's email
}
class NotifyService { notify<P>(input: NotifyInput<P>): Promise<void> }   // never throws
// format-when.ts
export function formatWhen(date: Date, timeZone: string): string; // 'Oct 26, 2026 at 10:42 AM GMT+5'; invalid tz ⇒ UTC
export function formatDay(date: Date, timeZone: string): string;  // 'Nov 2, 2026'
export function initials(name: string): string;                    // 'M Rehman' ⇒ 'MR', 'sana@x.pk' ⇒ 'SA'
```

**Behaviour of `notify`:**
- bell runs only when `event === null`, or when `shouldSend(userId, ws, event, 'app')` is true.
- email: `enqueue({ ...email, to: { email: email.to ?? user.email, userId }, workspaceId })`.
- Each part is in its own try/catch with `logger.warn`.
- `RecipientsService` lifts `InboxNotifyService.loadMembers` / `displayName` and `DraftApprovalService.approverIds`. Those callers are switched in T13 and T16, not here.

Steps:

- [ ] **Step 1: Failing tests**

```ts
it('skips the bell when the app preference is off, still enqueues the email', ...);
it('mandatory (event null) always rings the bell', ...);
it('a throwing bell does not stop the email, and notify resolves', ...);
it('formatWhen formats in the zone with a short zone name', () => expect(formatWhen(new Date('2026-10-26T05:42:00Z'), 'Asia/Karachi')).toBe('Oct 26, 2026 at 10:42 AM GMT+5'));
it('formatWhen falls back to UTC for an invalid zone', ...toBe('Oct 26, 2026 at 5:42 AM UTC'));
it('initials', ...);
// db spec: admins() returns owner + ACCEPTED ADMIN only (MEMBER, GUEST and PENDING excluded), deduped when the owner also holds an ADMIN row
```

- [ ] **Step 2–4:** run, expect FAIL, implement, run, expect PASS. Use `npx jest src/notifications src/email/links`, plus the DB spec.
- [ ] **Step 5: Typecheck (35), lint, commit** `feat(notifications): NotifyService façade and shared recipient lookup`.

---

### Task 6: A1/A2 restyle, A5 change password, session revocation

**Files:**
- Create:
  - `drizzle/migrations/0070_users_sessions_revoked_at.sql`
  - `src/email/templates/security/{verify-email,reset-password,password-changed}.tsx`
  - `src/users/account-security.controller.ts`
  - `src/users/account-security.service.ts`
  - `src/users/dto/change-password.dto.ts`
- Modify:
  - `src/drizzle/schema/users.schema.ts` (`sessionsRevokedAt: timestamp('sessions_revoked_at', { withTimezone: true })`)
  - `src/users/users.service.ts` (`PublicUser` + `hasPassword`; `update` refuses email/password)
  - `src/users/dto/update-user.dto.ts`
  - `src/users/users.module.ts`
  - `src/auth/strategies/jwt.strategy.ts`, `jwt-refresh.strategy.ts` (iat check)
  - `src/auth/auth.service.ts` (A1/A2 via `sendNow`, A5 on `resetPassword`, revoke on reset)
  - `src/email/templates/security/index.ts`
  - `src/email/email.service.ts` (delete `sendVerificationEmail`, `sendPasswordResetEmail`)
  - `package.json` (`bowser@^2.15.0`)
- Test:
  - `src/users/account-security.service.spec.ts`
  - `src/auth/strategies/jwt.strategy.spec.ts` (extend)
  - `src/users/users.service.spec.ts` (extend)
  - `src/auth/auth.service.spec.ts` (adjust the mocks)

**Interfaces:**
- Consumes: T3 `sendNow`/`enqueue`, `AppLinks`; T4 `securityToken`; T5 `NotifyService`, `RecipientsService`, `formatWhen`; `GeoipService.lookup(ip)`.
- Produces (used by T7):

```ts
class AccountSecurityService {
  changePassword(userId: string, body: { currentPassword?: string; newPassword: string }, ctx: { ip: string | null; userAgent: string | null }): Promise<void>;
  revokeSessions(userId: string): Promise<void>;                 // sessions_revoked_at = now()
  verifyCurrentPassword(user: { password: string | null }, current: string | undefined): Promise<void>; // throws CURRENT_PASSWORD_REQUIRED / _INCORRECT
  deviceLabel(userAgent: string | null): string;                 // bowser: 'Chrome on Windows'; null/unparseable ⇒ 'Unknown browser' (T8 reuses it)
}
// POST /users/me/password → 200 { accessToken } + refresh cookie (setRefreshCookie)
type PasswordChangedProps = { when: string; device: string; location: string | null; via: 'settings' | 'reset'; resetUrl: string };
type VerifyEmailProps = { code: string; email: string };
type ResetPasswordProps = { email: string; resetUrl: string };
```

**Values:**
- Copy is the Figma A1, A2 and A5 text verbatim.
  - A5 `via: 'reset'` body: `We signed you out everywhere. Sign in with your new password.`
  - The A5 button `Reset password` links `resetUrl` = `links.api('/email/security/' + securityToken({uid, act:'not_me'}))`.
- Footers:
  - A1 is `plain`, with `footerReason: (p) => \`You get this because someone signed up for Schedura with ${p.email}.\``;
  - A2 is `plain`, with `You get this because a password reset was requested for your account.`;
  - A5 is `security`.
- Idempotency keys:
  - `verify.${userId}.${codeExpiresAtMs}`;
  - `reset.${userId}.${tokenExpiresAtMs}`;
  - `password-changed.${userId}.${Date.now()}`.
- JWT check: reject when `payload.iat < Math.floor(user.sessionsRevokedAt.getTime() / 1000)`, with `UnauthorizedException('Session ended')`.
- `UpdateUserDto` keeps `email`/`password` as optional strings. The service throws the `USE_EMAIL_CHANGE_FLOW` / `USE_PASSWORD_CHANGE_FLOW` bodies from Appendix A.4.
- The `ChangePasswordDto` new-password rules copy `src/auth/dto/reset-password.dto.ts`.
- Error bodies are Appendix A.3 verbatim.
- `POST /users/me/password` is throttled to `@Throttle({ default: { limit: 5, ttl: 3_600_000 } })`.
- The A5 bell is `notificationEmitter.passwordChanged(userId)` with event `security_alert`.

Steps:

- [ ] **Step 1: Failing tests**

```ts
it('password user: missing current → CURRENT_PASSWORD_REQUIRED (400, not 401)', ...);
it('password user: wrong current → CURRENT_PASSWORD_INCORRECT', ...);
it('same new password → PASSWORD_UNCHANGED', ...);
it('google-only user (password null) → PASSWORD_NOT_SET and nothing is written', ...);
it('success hashes, sets sessions_revoked_at, enqueues password-changed (security footer), rings passwordChanged when security_alert app is on', ...);
it('jwt strategy rejects a token issued before sessions_revoked_at and accepts one issued in the same second', ...);
it('PATCH /users/:id with email → USE_EMAIL_CHANGE_FLOW; with name only → updates', ...);
it('toPublicUser exposes hasPassword and never password', ...);
it('register sends A1 through sendNow with the verify key and still reports a send failure', ...);
it('resetPassword revokes sessions and enqueues password-changed with via "reset"', ...);
```

- [ ] **Step 2: Run, expect FAIL.** `npx jest src/users src/auth`.
- [ ] **Step 3: Implement.**
  - Migration 0070: `ALTER TABLE users ADD COLUMN sessions_revoked_at timestamptz;`. Write the header comment.
  - `AccountSecurityController`: `@Controller('users/me')`, `@UseGuards(JwtAuthGuard)`, `@Post('password')`. It returns the new access token via `AuthService.generateAccessToken`, and sets the cookie from `generateRefreshToken` with `setRefreshCookie`.
- [ ] **Step 4: Run, expect PASS.** Then `npm run email:preview`: `verify-email.html`, `reset-password.html`, `password-changed.html` and `password-changed--reset.html` exist.
- [ ] **Step 5: Typecheck (35), lint, commit** `feat(auth): change password needs the current one, signs out other sessions; A1/A2/A5 templates`.

---

### Task 7: A3/A4 change email and the security-link actions (depends on Task 6)

**Files:**
- Create:
  - `drizzle/migrations/0071_users_pending_email.sql`
  - `src/email/templates/security/{change-email-code,email-changed}.tsx`
  - `src/users/email-change.service.ts`
  - `src/users/dto/email-change.dto.ts`
  - `src/email/public/security-actions.service.ts`
- Modify:
  - `src/drizzle/schema/users.schema.ts`: `pendingEmail varchar(255)`, `pendingEmailCodeHash varchar(64)`, `pendingEmailExpiresAt timestamptz`, `pendingEmailAttempts integer not null default 0`
  - `src/users/account-security.controller.ts` (two routes)
  - `src/email/public/email-public.controller.ts` (`GET`/`POST security/:token`)
  - `src/email/templates/security/index.ts`
- Test:
  - `src/users/email-change.service.spec.ts`
  - `src/users/email-change.db.spec.ts`
  - `src/email/public/security-actions.service.spec.ts`

**Interfaces:**
- Consumes: T6 `verifyCurrentPassword`, `revokeSessions`; T4 `securityToken`/`verifySecurity`, `confirmPage`/`donePage`; `normalizeEmail` from `src/users/normalize-email.ts`; `MAX_CODE_ATTEMPTS` and `verificationCodeError` from `src/auth/verification-code-error.ts`.
- Produces:

```ts
class EmailChangeService {
  request(userId: string, body: { newEmail: string; currentPassword?: string }): Promise<{ pendingEmail: string; expiresAt: string }>;
  confirm(userId: string, code: string, ctx: { ip: string | null; userAgent: string | null }): Promise<PublicUser>;
}
class SecurityActionsService { describe(token: string): Promise<{ title: string; body: string; button: string } | null>; perform(token: string): Promise<{ title: string; body: string } | null> }
type ChangeEmailCodeProps = { code: string; newEmail: string };
type EmailChangedProps = { from: string; to: string; when: string; device: string; secureUrl: string };
```

**Values:**
- The code is 6 digits from `crypto.randomInt(0, 1_000_000)`, zero-padded. It is stored as sha256 hex, expires in 10 min, and allows 5 attempts.
- `confirm` strips spaces from `code`.
- `request`:
  - throttled 5/hour, per route as in T6;
  - re-requesting replaces the pending code;
  - a send failure clears the pending columns and throws `503 EMAIL_SEND_FAILED`.
- `confirm`, in one transaction:
  1. `SELECT … FOR UPDATE`;
  2. check expiry, then attempts, then hash;
  3. check that the email is still free (`409 EMAIL_TAKEN`), and catch the unique violation `23505` as the same 409;
  4. update `email` and `isEmailVerified = true`, and clear the pending columns.
- After commit, enqueue A4 to the OLD address with key `email-changed.${userId}.${Date.now()}` and `secureUrl` = `links.api('/email/security/' + securityToken({uid, act: 'revert_email', from: old, to: new}))`.
- Security pages (GET):
  - `revert_email`: title `Switch your email back?`, body `Your sign-in email will go back to ${from}, we'll sign you out everywhere, and we'll send a reset link there.`, button `Secure my account`.
  - `not_me`: title `Secure your account?`, body `We'll sign you out everywhere and send a password reset link to ${maskedEmail}.`, button `Secure my account`.
- POST, per spec §7.3:
  - The done title is `Your account is secured`.
  - The failed-revert page body is `We couldn't switch your email back. Write to ${SUPPORT_EMAIL} and we'll help.`
  - `not_me` issues the reset token through the same code path as `AuthService.forgotPassword` (extract its token-issuing part into `issuePasswordReset(user)` and reuse it), then sends A2 via `sendNow`.
- Masking: `r•••@lumierecafe.pk` (first char + `•••` + `@domain`).

Steps:

- [ ] **Step 1: Failing tests**

```ts
it('request: password user without current password → CURRENT_PASSWORD_REQUIRED', ...);
it('request: same address (after normalisation, e.g. "Me@X.com " vs "me@x.com") → EMAIL_UNCHANGED', ...);
it('request: address of another user → 409 EMAIL_TAKEN', ...);
it('request: sends A3 inline to the NEW address only, stores sha256 not the code', ...);
it('confirm: wrong code → CODE_INVALID with attemptsLeft 4; 5th wrong → CODE_LOCKED and pending cleared', ...);
it('confirm: expired → CODE_EXPIRED', ...);
it('confirm: "305 771" with a space is accepted', ...);
it('confirm: success switches email, verifies it, enqueues A4 to the OLD address with a revert link', ...);
// db spec: another user registers the new address between request and confirm → 409 EMAIL_TAKEN, users row unchanged, no 500
it('GET security link changes nothing; POST not_me revokes sessions and sends A2', ...);
it('POST revert_email when the email was changed again since → failure page, nothing written', ...);
```

- [ ] **Step 2–4:** run, expect FAIL, implement (migration 0071 with a header), run, expect PASS. Use `npx jest src/users src/email/public`, plus the DB spec. Run `npm run email:preview`.
- [ ] **Step 5: Typecheck (35), lint, commit** `feat(auth): verified email change with a code to the new address and a way back from the old`.

---

### Task 8: A6 new sign-in on an unknown device

**Files:**
- Create:
  - `drizzle/migrations/0072_known_devices.sql`
  - `src/drizzle/schema/known-devices.schema.ts`
  - `src/auth/devices/{device-cookie.ts,known-devices.service.ts}`
  - `src/email/templates/security/new-sign-in.tsx`
- Modify:
  - `src/auth/auth.controller.ts` (login and register read `req.cookies.sd_device` and set it)
  - `src/auth/google/google-auth.controller.ts`
  - `src/auth/google/google-auth.service.ts`
  - `src/auth/auth.service.ts` (`login` gets a `deviceId` param)
  - `src/drizzle/schema/index.ts`
  - `src/email/templates/security/index.ts`
- Test:
  - `src/auth/devices/known-devices.service.spec.ts`
  - `src/auth/devices/known-devices.db.spec.ts`
  - `src/auth/devices/device-cookie.spec.ts`

**Interfaces:**
- Consumes: T5 `NotifyService`, `formatWhen`; `GeoipService.lookup`; T6 `deviceLabel`.
- Produces:

```ts
export const DEVICE_COOKIE = 'sd_device';
export function readOrMintDeviceId(cookie: string | undefined): { id: string; isNew: boolean }; // valid = /^[A-Za-z0-9_-]{43}$/
export function setDeviceCookie(res: Response, id: string): void; // HttpOnly, Secure, SameSite=None, maxAge 400 days
class KnownDevicesService {
  /** Returns 'known' | 'first' (silently recorded) | 'new' (recorded, A6 sent). */
  seen(userId: string, deviceId: string, ctx: { ip: string | null; userAgent: string | null }, opts?: { silent?: boolean }): Promise<'known' | 'first' | 'new'>;
}
type NewSignInProps = { when: string; device: string; location: string | null; ip: string | null; notMeUrl: string };
```

**Values:**
- `device_hash` = sha256 hex of the cookie value.
- Migration 0072: `known_devices(user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, device_hash char(64) NOT NULL, label varchar(120) NOT NULL, country varchar(100), first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, device_hash))`.
- The A6 subject is `New sign-in to Schedura from ${device}`.
- The preheader is `${location ?? 'Unknown location'} · ${shortWhen}`, where `shortWhen` is `Oct 26 at 9:58 PM`.
- The IP row is omitted when null.
- The idempotency key is `new-sign-in.${userId}.${deviceHash.slice(0,16)}`.
- Event `security_alert` for the `newLogin` bell. The email is mandatory.
- `register` and the Google `create` branch call `seen(…, { silent: true })`.
- Login and the Google existing-user branch call `seen` after a successful auth, never before; a failed password creates no row.
- `seen` never throws into login: wrap it and log.

Steps:

- [ ] **Step 1: Failing tests**

```ts
it('first device for a user is recorded silently (no email)', ...→ 'first', enqueue not called);
it('unknown device for a user with a known device sends A6 and rings newLogin', ...→ 'new');
it('known device updates last_seen_at and sends nothing', ...);
it('a malformed cookie is replaced with a new id', ...);
it('bowser label: Chrome on Windows; empty UA → Unknown browser', ...);
it('A6 omits the IP row when ip is null', ...);
// db spec: concurrent two seen() for the same new device insert one row (ON CONFLICT DO NOTHING) and send one email
```

- [ ] **Step 2–4:** run, expect FAIL, implement, run, expect PASS. Use `npx jest src/auth`, plus the DB spec.
- [ ] **Step 5: Typecheck (35), lint, commit** `feat(auth): new-device sign-in email with a known-devices table`.

---

### Task 9: F1 welcome and F2–F5 lifecycle re-templates

**Files:**
- Create: `src/email/templates/lifecycle/{welcome,inactive-reminder,pausing-soon,account-paused,deletion-warning}.tsx`
- Modify:
  - `src/email/templates/lifecycle/index.ts`
  - `src/auth/auth.service.ts` (`verifyEmailWithOtp`, `verifyEmail` → F1)
  - `src/auth/google/google-auth.service.ts` (create branch → F1)
  - `src/admin/user-inactivity.service.ts` (enqueue F2–F4; keep the policy disabled)
  - `src/email/email.service.ts` (delete `sendInactivityReminder15Days`, `sendInactivityReminder25Days`, `sendInactivityDeactivationNotice`, `sendAccountDeletionWarning`)
- Test:
  - `src/email/templates/lifecycle/lifecycle.spec.ts`
  - extend `src/auth/auth.service.spec.ts`
  - `src/admin/user-inactivity.service.spec.ts` (create if absent)

**Interfaces:**
- Consumes: T3 `enqueue`, `AppLinks`, `EmailOnceService`; T5 `RecipientsService`, `formatDay`.
- Produces:

```ts
type WelcomeProps = { firstName: string; openUrl: string };
type InactiveReminderProps = { workspaceName: string; channels: number; drafts: number; scheduledThisWeek: number; openUrl: string };
type PausingSoonProps = { pauseDate: string; signInUrl: string };
type AccountPausedProps = { pausedSince: string; deleteOn: string; signInUrl: string; supportEmail: string };
type DeletionWarningProps = { deleteOn: string; deleteOnLong: string; signInUrl: string; supportEmail: string };
```

**Values:**
- Copy is the Figma F1–F5 text verbatim.
  - `firstName` = the first word of `name`, else `there`.
  - F2 "Scheduled" shows `Nothing this week` when 0.
- Footers:
  - F1 is `plain` with `You get this because you created a Schedura account.`;
  - F2 has `event: 'inactivity_reminder'`, `footer: 'plain'`, `footerReason` `You get this because you haven't signed in for 15 days.`, and links `Stop these reminders` (the unsubscribe URL for `{uid, ws: null, ev: 'inactivity_reminder'}`) `· Help center · Privacy`. Add a `footerLinksFor(p, ctx)` hook if needed, or let `EmailFooterService` special-case `inactivity_reminder`. Pick the latter, as one `if` with a comment.
  - F3–F5 are `account`.
- The F1 key is `welcome.${userId}`, plus `EmailOnceService.claim('welcome.' + userId, 30 * 86400)`.
- `signInUrl`/`openUrl` = `links.frontend('/login')` and `links.frontend('/')`.
- F2 counts come from the user's `lastAccessedWorkspaceId`.
- `runManualCheck` still throws, and no `@Cron` is added. Assert both in the spec.

Steps:

- [ ] **Step 1: Failing tests:**
  - verifying the email enqueues `welcome` once, and a second verify sends nothing;
  - the Google create branch enqueues `welcome`, and the existing-user branch does not;
  - the F2 footer has "Stop these reminders" linking `/email/unsubscribe/`;
  - `runManualCheck` still refuses, and the service has no `@Cron` metadata;
  - F5 contains the `SUPPORT_EMAIL` value and never `yourdomain`.
- [ ] **Step 2–4:** run, expect FAIL, implement, run, expect PASS: `npx jest src/email/templates/lifecycle src/auth src/admin`. Run `npm run email:preview`.
- [ ] **Step 5: Typecheck (35), lint, commit** `feat(email): welcome email and calmer inactivity templates`.

---

### Task 10: B1 invitation, B2 accepted, B3 removed

**Files:**
- Create: `src/email/templates/team/{workspace-invitation,invitation-accepted,removed-from-workspace}.tsx`
- Modify:
  - `src/email/templates/team/index.ts`
  - `src/workspace-members/workspace-members.service.ts` (`inviteMember`, resend path, `acceptInvitation`, `removeMember`)
  - `src/email/email.service.ts` (delete `sendWorkspaceInvitation`)
- Test:
  - `src/email/templates/team/team.spec.ts`
  - extend `src/workspace-members/workspace-members.service.spec.ts`

**Interfaces:**
- Consumes: T3 `enqueue`, `AppLinks.invite/members`; T5 `NotifyService`, `RecipientsService`, `formatDay`, `initials`.
- Produces:

```ts
export const ROLE_EMAIL_LINE: Record<'ADMIN'|'MEMBER'|'GUEST', string>; // spec §4.4 item 6
type InvitationProps = { inviterName: string; inviterEmail: string; workspaceName: string; role: 'ADMIN'|'MEMBER'|'GUEST'; channels: number; members: number; acceptUrl: string; inviteeEmail: string; expiresInDays: number };
type InvitationAcceptedProps = { memberName: string; memberEmail: string; workspaceName: string; role: 'ADMIN'|'MEMBER'|'GUEST'; joined: string; membersUrl: string };
type RemovedProps = { workspaceName: string; removedByName: string; removedOn: string; openUrl: string };
```

**Values:**
- Copy is Figma B1–B3 verbatim, with the role label via `ROLE_EMAIL_LINE` (spec §4.4 item 6).
- The B2 preheader is `They can now ${roleVerb} as ${roleLabel}.`, with roleVerb:
  - ADMIN `manage the workspace`;
  - MEMBER `create and schedule posts`;
  - GUEST `draft posts and view the workspace`.
- Footers:
  - B1 is `plain`, with `You get this because ${inviterName} invited ${inviteeEmail}.`;
  - B2 is `notification` (event `member_activity`);
  - B3 is `plain`, with `You get this because your access to a workspace changed.`
- B3 is sent only when `member.userId !== currentUserId` (not self-leave) and `member.userId` is set.
- Bells:
  - `invitationAccepted(inviterId, memberName, workspaceName)` under event `member_activity`;
  - `memberRemoved(userId, workspaceName, removedBy)` with event null.
- Keys:
  - `invite.${invitationId}.${expiresAtMs}`, so a resend after the token rotates is a new key;
  - `invite-accepted.${invitationId}`;
  - `member-removed.${workspaceId}.${userId}.${Date.now()}`.

Steps:

- [ ] **Step 1: Failing tests:**
  - invite enqueues `workspace-invitation` to the invitee with the accept URL `http://localhost:3001/invite/accept?token=…`;
  - accept notifies the inviter (bell + B2) and not the accepter;
  - removing another member sends B3 + bell, and self-leave sends nothing;
  - a GUEST role renders `Viewer · draft posts and view the workspace`;
  - a workspace name `A & <B>` is escaped.
- [ ] **Step 2–4:** run, expect FAIL, implement, run, expect PASS: `npx jest src/email/templates/team src/workspace-members`. Run the preview.
- [ ] **Step 5: Typecheck (35), lint, commit** `feat(email): team invitation, joined and removed emails`.

---

### Task 11: C1/C1a post failures, batched per recipient in a 10-minute window

**Files:**
- Create:
  - `src/email/batching/post-failure-batch.service.ts`
  - `src/email/templates/publishing/{post-failed,posts-failed}.tsx`
  - `src/posts/services/publish-failure-notifier.service.ts`
- Modify:
  - `src/email/queue/email.processor.ts` (job `post-failed-flush`)
  - `src/email/email.module.ts`
  - `src/email/templates/publishing/index.ts`
  - `src/posts/services/post.service.ts` (after `finalStatus`, before return)
  - `src/posts/processors/post-publish.processor.ts` (`onFailed` + `isFinalAttempt`)
  - `src/posts/posts.module.ts`
- Test:
  - `src/email/batching/post-failure-batch.service.spec.ts`
  - `src/posts/services/publish-failure-notifier.service.spec.ts`
  - extend `src/posts/services/post.service.spec.ts`

**Interfaces:**
- Consumes: T3 `EmailOutboxService`, the email queue (`@InjectQueue(QUEUES.EMAIL)`), the Redis client, `AppLinks`; T5 `NotifyService`, `RecipientsService`, `formatWhen`; T2 `shouldSend`.
- Produces:

```ts
export interface FailureEntry { postId: string; platform: string; handle: string; caption: string; thumbnailUrl: string | null; scheduledFor: string /* ISO */; reason: string; otherPublished: string[] /* platform names */ }
class PostFailureBatchService {
  record(userId: string, workspaceId: string, entry: FailureEntry): Promise<void>;
  flush(userId: string, workspaceId: string, windowId: string): Promise<'sent' | 'empty' | 'skipped'>;
}
export const POST_FAILED_FLUSH_JOB = 'post-failed-flush';
export const POST_FAILURE_WINDOW_MS = 600_000;
class PublishFailureNotifier {
  onPublishOutcome(post: { id: string; workspaceId: string; createdById: string | null; content: string | null; mediaUrls?: string[]; scheduledAt: Date | null; targets: Array<{ channelId: number|string; platform: string; status: string; errorMessage?: string | null }> }, triggeredBy: string): Promise<void>;
  onFinalJobFailure(postId: string, error: Error): Promise<void>;
}
type PostFailedProps = { platform: string; platformName: string; handle: string; when: string; caption: string; thumbnailUrl: string | null; reason: string; otherPublished: string[]; editUrl: string };
type PostsFailedProps = { count: number; rows: Array<{ platform: string; handle: string; when: string; title: string; reason: string; thumbnailUrl: string | null }>; more: number; otherOnTime: number; plannerUrl: string };
```

**Algorithm (spec §6, exact):**
- `record(u, ws, e)`:
  1. `RPUSH email:pf:{u}:{ws} JSON(e)`, `EXPIRE` 1800;
  2. `SET email:pf-open:{u}:{ws} {windowId=Date.now()} NX EX 900`;
  3. only when step 2 claimed: `queue.add(POST_FAILED_FLUSH_JOB, {u, ws, windowId}, { jobId: \`post-failed.${u}.${ws}.${windowId}\`, delay: POST_FAILURE_WINDOW_MS, attempts: 5, backoff: {type:'exponential', delay: 2000} })`.
- `flush`:
  1. `DEL email:pf-open:{u}:{ws}`;
  2. `RENAME email:pf:{u}:{ws} email:pf-flush:{windowId}` (no such key → return `'empty'`);
  3. `LRANGE 0 -1`, then `DEL` the flush key;
  4. dedupe by `postId`, keeping the last entry;
  5. if `!shouldSend(u, ws, 'post_failed', 'email')`, return `'skipped'`;
  6. one entry → `post-failed`; several → `posts-failed` with at most 10 rows and `more = n - 10`;
  7. deliver through `outbox.process({…, idempotencyKey: jobId})`.
- `otherOnTime` = the count of posts in ws with `status = 'published'` and `published_at >= local midnight` (workspace tz), excluding the failed ids.

**Who and when:**
- `onPublishOutcome` acts only when `triggeredBy === 'scheduler'` and the final status is `failed` or `partially_published`.
- Recipients: `createdById` ∪ `admins(ws)`, deduped.
- For each recipient:
  - the bell `postFailed(userId, platformName, title, reason)` is immediate (app locked, but still call through `notify` with event `post_failed`);
  - then `record`.
- `title` = the first 60 chars of the caption, else `(No caption)`.
- `handle` = the channel `username`/`accountName` from `social_media_channels`.
- `editUrl` = `links.planner(ws, postId)`, and `plannerUrl` = `links.planner(ws)`.
- `onFinalJobFailure` loads the post and records every target as failed with `reason = error.message`.

**Copy:** Figma C1/C1a verbatim, with these deviations:
- the "Why this happens" line is dropped (spec §4.4 item 1);
- C1's body sentence is `The same post on ${otherPublished.join(' and ')} went out on time.` only when non-empty; otherwise `Fix it and publish again.`;
- C1's heading and subject are `Your ${platformName} post didn't publish`;
- the C1 preheader is `${platformName} didn't accept it. Edit it and we'll try again.`;
- C1a's subject is `${count} posts didn't publish today`;
- C1a's preheader lists distinct networks, `Instagram, TikTok and LinkedIn each turned one down.`;
- "Your other N posts went out on time." is omitted when N is 0.

The callout is `danger` and shows `reason` truncated to 200.

Steps:

- [ ] **Step 1: Failing tests** (a fake Redis with real list/rename semantics: an in-memory Map, plus a fake queue)

```ts
it('first failure opens a window and schedules one delayed flush with a colon-free jobId', ...expect(add).toHaveBeenCalledWith('post-failed-flush', expect.anything(), expect.objectContaining({ delay: 600000, jobId: expect.not.stringContaining(':') })));
it('a second failure in the window schedules nothing new', ...);
it('flush with one entry sends post-failed; three entries send posts-failed', ...);
it('flush dedupes the same post', ...);
it('a failure recorded during flush lands in a new window', ...); // record between DEL open and RENAME
it('flush skips a recipient removed from the workspace (shouldSend false)', ...);
it('15 failures → 10 rows and "and 5 more"', ...);
it('user-initiated publish (triggeredBy "user") records nothing', ...);
it('partially_published notifies with the published platforms in otherPublished', ...);
it('empty caption renders (No caption); a 5000-char caption is truncated', ...);
```

- [ ] **Step 2–4:** run, expect FAIL, implement, run, expect PASS: `npx jest src/email/batching src/posts`. Run the preview.
- [ ] **Step 5: Typecheck (35), lint, commit** `feat(email): batched post-failure emails (C1/C1a)`.

---

### Task 12: C2 channel needs reconnecting (expired and expiring)

**Files:**
- Create:
  - `src/email/templates/publishing/channel-reconnect.tsx`
  - `src/channels/services/channel-health-notifier.service.ts`
- Modify:
  - `src/channels/processors/token-refresh.processor.ts` (conditional update + notify on the transition)
  - `src/channels/schedulers/refresh-token-expiry.scheduler.ts` (`WARNING_THRESHOLD_DAYS = 7`; replace the TODO)
  - `src/channels/channels.module.ts`
  - `src/email/templates/publishing/index.ts`
- Test:
  - `src/channels/services/channel-health-notifier.service.spec.ts`
  - extend the processor and scheduler specs, or create them if absent

**Interfaces:**
- Consumes: T3 `EmailOnceService`; T5 `NotifyService`, `RecipientsService`, `formatWhen`, `formatDay`.
- Produces:

```ts
class ChannelHealthNotifier {
  expired(channel: { id: number; workspaceId: string; platform: string; accountName: string }, at: Date): Promise<void>;
  expiring(channel: { id: number; workspaceId: string; platform: string; accountName: string; refreshTokenIssuedAt: Date }, daysLeft: number, endsAt: Date): Promise<void>;
}
type ChannelReconnectProps = { kind: 'expired' | 'expiring'; platform: string; platformName: string; handle: string; accountType: string; statusLine: string; waiting: number; nextWhen: string | null; endsOn?: string; reconnectUrl: string };
```

**Values:**
- `expired` fires only when the update `SET connection_status='expired' … WHERE id = $1 AND connection_status <> 'expired' RETURNING id` returned a row (the transition). Then:
  - claim `channel-expired.${id}.${dayIsoUtc}` for 7 days;
  - email key `channel-expired.${id}.${atMs}`;
  - recipients `admins(ws)`;
  - bell `tokenExpired(userId, platformName, accountName)` with event `channel_health`.
- `expiring`, for `daysLeft <= 7` and `daysLeft <= 1` stages:
  - stage = `daysLeft <= 1 ? '1' : '7'`;
  - claim `channel-expiring.${id}.${issuedAtMs}.${stage}` with a TTL of 30 days;
  - email key = the same string.

  It is email only, with no bell.
- `waiting` = scheduled posts whose `targets` contain the channel. Match the JSON type of `PostTarget.channelId` in `posts.schema.ts`, and use jsonb containment `@>`. `nextWhen` = `formatWhen` of the earliest `scheduled_at`.
- Copy:
  - The `expired` subject and heading are Figma C2 verbatim (`Reconnect ${platformName} to keep posting`). The badge is `Needs you`.
  - The callout is `${waiting} scheduled posts won't publish until you reconnect. The next one is ${nextWhen}.`; when `waiting = 0` it is omitted.
  - The `expiring` subject and heading are `Reconnect ${platformName} before ${endsOn}`. The preheader is `${platformName} access for ${handle} ends on ${endsOn}.`, the badge `Expires soon`, and the callout (warning) `Reconnect before ${endsOn} so ${waiting} scheduled posts still go out.`
  - Button `Reconnect ${platformName}` → `links.channels(ws)`. Note `Only owners and admins can reconnect a channel.`
  - `ChannelCard` is local to this template: a PostCard-style box with the network icon, the handle, `statusLine` and a badge.

Steps:

- [ ] **Step 1: Failing tests:**
  - only the connected→expired transition emails, and a second failure on an already-expired channel sends nothing;
  - the same incident claimed twice sends once;
  - the scheduler sends stage 7 at daysLeft 6 and stage 1 at daysLeft 1, and never twice per stage;
  - the waiting count is 0 → no callout;
  - recipients are owner + admins only.
- [ ] **Step 2–4:** run, expect FAIL, implement, run, expect PASS: `npx jest src/channels`. Run the preview.
- [ ] **Step 5: Typecheck (35), lint, commit** `feat(email): reconnect-channel emails on expiry and before it`.

---

### Task 13: C3 approval needed, C4 post approved

**Files:**
- Create: `src/email/templates/publishing/{approval-needed,post-approved}.tsx`
- Modify:
  - `src/posts/composer/services/draft-approval.service.ts` (`notifyApprovers`, `notifyRequester` go through `NotifyService`; `approverIds` uses `RecipientsService.admins`)
  - `src/email/templates/publishing/index.ts`
- Test:
  - extend `src/posts/composer/services/draft-approval.service.spec.ts` (create if absent)
  - `src/email/templates/publishing/approvals.spec.ts`

**Interfaces:**
- Consumes: T5 `NotifyService`, `RecipientsService`, `formatWhen`; T3 `AppLinks.planner`.
- Produces:

```ts
type ApprovalNeededProps = { requesterName: string; platform: string; handle: string; when: string; caption: string; thumbnailUrl: string | null; campaignName: string | null; goesOut: string; reviewUrl: string; workspaceName: string };
type PostApprovedProps = { approverName: string; platform: string; platformName: string; handle: string; when: string; caption: string; thumbnailUrl: string | null; goesOutSentence: string; plannerUrl: string };
```

**Values:**
- C3:
  - Figma copy, with the Quote omitted (spec §4.4 item 2);
  - preheader `${platformName} · ${when}${campaignName ? ' · ' + campaignName : ''}`;
  - the campaign row only when `post.metadata.campaignId` resolves to a campaign name;
  - `goesOut` = `formatWhen(scheduledAt)` or `Not scheduled yet`;
  - footer `notification`, event `approval_request`, `footerReason` `You get this because you approve posts in ${workspaceName}.`
- C4:
  - subject `${firstName(approverName)} approved your post`;
  - `goesOutSentence` = `It goes out on ${platformName} ${when}. Nothing else to do.`, or `It's ready to schedule.` when there is no time;
  - event `post_approved`.
- Keep the existing bells (`approvalRequested`, `draftApproved`) as the `bell` of the same `notify` call.
- Keys: `approval-requested.${postId}.${requestedAtMs}.${userId}` and `post-approved.${postId}.${approvedAtMs}`.
- The platform and handle come from the post's first target.

Steps:

- [ ] **Step 1: Failing tests:**
  - turning approval on emails each approver except the requester (when `ALLOW_SELF_APPROVAL` is false), with the C3 footer reason;
  - approving emails the requester C4;
  - turning `approval_request` email off stops the email but not the bell;
  - a draft with no schedule shows `Not scheduled yet`.
- [ ] **Step 2–4:** run, expect FAIL, implement, run, expect PASS: `npx jest src/posts/composer src/email/templates/publishing`. Run the preview.
- [ ] **Step 5: Typecheck (35), lint, commit** `feat(email): approval requested and approved emails`.

---

### Task 14: D1 payment failed, D2 trial ending, D3 plan changed (Stripe + LemonSqueezy)

**Files:**
- Create:
  - `src/email/templates/billing/{payment-failed,trial-ending,plan-changed}.tsx`
  - `src/billing/services/billing-email.service.ts`
  - `src/billing/services/trial-ending.cron.ts`
- Modify:
  - `src/billing/services/webhook.service.ts` (`handleInvoicePaymentFailed`, `handleTrialWillEnd`, `handleSubscriptionUpdated` cancel transition, `handleSubscriptionDeleted`, `applyPaymentFailureRestrictions`)
  - `src/billing/services/lemonsqueezy-webhook.service.ts` (`handlePayment` failed; `handleLifecycle` cancelled/expired)
  - `src/billing/services/plan-change.service.ts` (both `planChanged` sites)
  - `src/billing/billing.module.ts`
  - `src/email/templates/billing/index.ts`
- Test:
  - `src/billing/services/billing-email.service.spec.ts`
  - `src/billing/services/trial-ending.cron.spec.ts`
  - extend `webhook.provider-row.spec.ts` / `lemonsqueezy-webhook.service.spec.ts` with one assertion each that the email service was called

**Interfaces:**
- Consumes: T3 `EmailOnceService`, `AppLinks.billing`; T5 `NotifyService`, `RecipientsService`, `formatDay`.
- Produces:

```ts
class BillingEmailService {
  paymentFailed(i: { userId: string; planName: string; amountCents: number; currency: string; cardLast4: string | null; cardBrand: string | null; reason: string | null; nextAttempt: Date | null; dedupeKey: string }): Promise<void>;
  trialEnding(i: { userId: string; subscriptionId: number | string; trialEnd: Date; planCode: string; hasCard: boolean | null }): Promise<void>;
  planChanged(i: { userId: string; kind: 'upgraded' | 'downgraded' | 'cancel_scheduled' | 'ended' | 'payment_restricted'; fromPlan: string; toPlan: string; billed: string | null; nextCharge: Date | null; endsOn: Date | null; dedupeKey: string }): Promise<void>;
}
```

**Values:**
- Recipient: `subscriptions.userId` (the payer and owner).
- The workspace for copy and billing link is the user's `lastAccessedWorkspaceId`, else their first owned workspace.
- `billing(ws)` → `/w/${ws}/settings/billing`.
- Footer `billing`, `event: null`.
- Bells, all under event `billing_alert`:
  - `paymentFailed(userId, amount, reason)`;
  - `subscriptionExpiring(userId, 3, planName)`;
  - `planChanged` as it exists.
- D1:
  - copy per Figma, with the callout from spec §4.4 item 3;
  - money via `Intl.NumberFormat('en-US', { style: 'currency', currency })`;
  - card `Visa •• 4242` (row omitted when unknown);
  - "Next try" only when known;
  - Stripe key `payment-failed.${invoice.id}.${attempt_count}`; LS key `payment-failed.ls.${invoiceId}`.
- D2:
  - Stripe: from `handleTrialWillEnd`.
  - LS: `TrialEndingCron` `@Cron('0 9 * * *', { timeZone: 'UTC', name: 'lsTrialEnding' })` selects `subscriptions` with `status = 'trialing'` and `trial_end` in `(now + 2d, now + 3d]`, joined to `provider_subscriptions.provider = 'lemonsqueezy'`.
  - Both paths claim `trial-ending.${subscriptionId}.${trialEndMs}` for 7 days.
  - Rows per spec §4.4 item 4, from `plans` (current plan code vs `FREE`). Use `aiTokensPerMonth` labelled `AI credits`. `-1` renders `Unlimited`.
- D3:

  | Kind | Heading | Subject | Rows / note |
  |---|---|---|---|
  | upgraded / downgraded | `You're on Schedura ${toPlan}` | `You're now on Schedura ${toPlan}` | Figma rows |
  | cancel_scheduled | `Your ${fromPlan} plan ends on ${endsOn}` | the same | body `Your workspaces move to Free on ${endsOn}. Nothing is deleted.` |
  | ended | `You're on Schedura Free` | `Your Schedura ${fromPlan} plan has ended` | |
  | payment_restricted | `Your workspaces moved to Free` | the same | body `We couldn't collect payment for Schedura ${fromPlan} after 3 tries. Update your card to switch back.`, button `Update card` |

  The button is `Manage billing` except where the table names another.
  - The "Stripe sends the receipt in a separate email." sentence appears only for Stripe upgrades.
  - Stripe `subscription.updated` emails `cancel_scheduled` only when the stored `cancelAtPeriodEnd` was false and the event's is true.
  - Keys: `plan-changed.${userId}.${kind}.${providerSubscriptionId}.${periodEndMs or Date.now()}`.

Steps:

- [ ] **Step 1: Failing tests:**
  - D1 renders the amount `$29.00` and the card, and omits "Next try" when null;
  - the same Stripe failure event delivered twice enqueues one job (the same key);
  - the LS cron picks a trialing LS sub ending in 2.5 days, skips a Stripe sub, and sends once across two runs;
  - `cancel_at_period_end` false→true emails `cancel_scheduled`, and true→true does not;
  - `applyPaymentFailureRestrictions` emails `payment_restricted`;
  - billing mail carries no List-Unsubscribe, and its footer says it can't be turned off.
- [ ] **Step 2–4:** run, expect FAIL, implement, run, expect PASS: `npx jest src/billing src/email/templates/billing`. Run the preview, with variants for each D3 kind.
- [ ] **Step 5: Typecheck (35), lint, commit** `feat(email): billing emails for payment failure, trial end and plan changes`.

---

### Task 15: E1 contact acknowledgement, contact enquiry and admin code restyle

**Files:**
- Create:
  - `src/email/templates/support/{contact-received,contact-enquiry}.tsx`
  - `src/email/templates/security/admin-login-code.tsx`
  - `src/contact/contact-reference.ts`
- Modify:
  - `src/contact/contact.service.ts`
  - `src/auth/admin-challenge.service.ts`
  - `src/email/templates/{support,security}/index.ts`
- Test:
  - `src/contact/contact.service.spec.ts` (create or extend)
  - `src/contact/contact-reference.spec.ts`
  - extend `src/auth/admin-challenge` spec if one exists

**Interfaces:**
- Consumes: T3 `sendNow`, `enqueue`, `AppLinks`; T5 `formatWhen`.
- Produces:

```ts
export function newContactReference(): string; // 'SCH-' + 6 chars of Crockford base32 (0-9 A-H J K M N P-T V-Z), crypto random
type ContactReceivedProps = { reference: string; topic: string; sentAt: string; message: string; maestroUrl: string };
type ContactEnquiryProps = { reference: string; topic: string; name: string; email: string; company: string | null; message: string };
type AdminLoginCodeProps = { code: string; ip: string | null };
```

**Values:**
- E1:
  - copy per Figma;
  - Quote meta `Your message · ${topic} · ${sentAt}`;
  - the message is truncated to 1 000 chars;
  - footer `plain`, `You get this because you contacted Schedura support.`, `extraFooterLinks: [{label: 'Status', href: links.status()}]` placed after Help center;
  - `replyTo` = `CONTACT_INBOX_EMAIL`, so replies reach the same inbox;
  - key `contact-ack.${reference}`.
- The enquiry to us:
  - subject `[${topic}] ${name} · #${reference}`;
  - `replyTo` = the sender;
  - `sendNow` with key `contact.${reference}`;
  - the result still decides `{delivered}`.
- The ack goes through `enqueue`; its failure is still logged and not returned.
- Admin code:
  - layout with CodeBox;
  - subject `${code} is your Schedura admin sign-in code`;
  - `sendNow` with key `admin-code.${challengeId}`, footer `security`.

Steps:

- [ ] **Step 1: Failing tests:**
  - the reference matches `/^SCH-[0-9A-HJKMNP-TV-Z]{6}$/`;
  - the enquiry is sent inline with `replyTo` = the sender, and the ack is enqueued with `replyTo` = the inbox;
  - an enquiry send failure returns `{delivered:false}` and enqueues no ack;
  - the honeypot path sends nothing;
  - the sender's message `<b>hi</b>` is escaped in both emails.
- [ ] **Step 2–4:** run, expect FAIL, implement, run, expect PASS: `npx jest src/contact src/auth`. Run the preview.
- [ ] **Step 5: Typecheck (35), lint, commit** `feat(email): contact acknowledgement with a reference number; restyled enquiry and admin code`.

---

### Task 16: Restyle inbox, drip review, insight report and lead emails

**Files:**
- Create: `src/email/templates/inbox/inbox-activity.tsx`, `src/email/templates/publishing/drip-review.tsx`, `src/email/templates/reports/{insight-report,lead-delivered}.tsx`
- Modify:
  - `src/inbox/conversations/services/inbox-notify.service.ts`
  - `src/drips/processors/drip.processor.ts`
  - `src/insights/reports/lib/report-email.ts`
  - `src/insights/reports/report-send.service.ts`
  - `src/ads/services/lead-router.service.ts`
  - `src/email/email.service.ts` (delete `sendDripNotification` and its builders)
  - the group index files
- Test: extend
  - `src/inbox/conversations/services/inbox-notify.service.spec.ts`
  - `src/insights/reports/lib/report-email.spec.ts`
  - `src/insights/reports/report-send.service.spec.ts`
  - the drip processor spec
  - the lead-router spec (create any that are absent)

**Interfaces:**
- Consumes: T3 `enqueue`, `deliver`, `AppLinks`; T5 `NotifyService`; T1 `renderEmail`.
- Produces:

```ts
type InboxActivityProps = { kind: 'assigned' | 'mention' | 'new_message'; sentence: string; workspaceName: string; conversationUrl: string };
type DripReviewProps = { campaignName: string; when: string; caption: string; platforms: string[]; reviewUrl: string };
// report-email.ts keeps its exported function name and return shape ({subject, html, text, headers}) but builds html/text via renderEmail(insightReportTemplate, …) — make it async if needed and update its one caller.
```

**Values:**
- Inbox:
  - The inbox notify level is checked first, unchanged (spec §5.3). Then `notify` is called with event `inbox_assigned`, `inbox_mention` or `inbox_new_message`.
  - The bell is the existing `emitter.inbox*` call.
  - The email is `inbox-activity`, enqueued with key `inbox.${userId}.${conversationId}.${windowIndex}`, where `windowIndex = Math.floor(Date.now() / 600_000)`.
  - Keep the Redis `inbox-mail:` throttle as is.
  - Heading = `sentence`, button `Open conversation` → `links.inbox(ws, conversationId)`.
- Drip:
  - `reviewUrl` = `links.planner(campaign.workspaceId)`. This fixes the bug B1: no more `${APP_URL}/drips/posts/:id`.
  - Subject `Review your post for "${campaignName}"` (no `[Action Required]`).
  - Event `drip_review`.
  - Key `drip-review.${dripPostId}`.
- Report:
  - Uses the Layout and blocks.
  - Keeps its own `List-Unsubscribe` from `ReportTokensService` and its footer text.
  - Sent by `report-send.service.ts` through `emailService.deliver` with key `report.${reportId}.${runAtMs}.${sha256(email).slice(0,12)}` and tags `{category:'reports', template:'insight-report'}`.
- Lead: `lead-router.service.ts` renders `lead-delivered` and calls `deliver` with key `lead.${leadId}.${routeId}` and tags `{category:'leads', template:'lead-delivered'}`. It still throws on failure, so its job retries.

Steps:

- [ ] **Step 1: Failing tests:**
  - an inbox user with notify `everything` and `inbox_new_message` email off gets the bell but no email;
  - notify `nothing` gets neither;
  - the drip review link is `http://localhost:3001/w/<ws>/planner`, and the html never contains `/drips/posts/`;
  - the report email still has `List-Unsubscribe-Post`, and its html has the shared footer line `Schedura · schedura.ai`;
  - the lead delivery passes a stable idempotency key across two retries.
- [ ] **Step 2–4:** run, expect FAIL, implement, run, expect PASS: `npx jest src/inbox src/drips src/insights/reports src/ads`.
- [ ] **Step 5: Typecheck (35), lint, commit** `feat(email): restyle inbox, drip, report and lead emails; fix the drip review link`.

---

### Task 17: Completeness, cleanup and full verification

**Files:**
- Modify:
  - `src/email/email.service.ts` (delete `sendEmail` once `grep -rn "sendEmail(" src --include=*.ts` shows only specs; delete the leftover `formatTimeUntilPublish` and HTML builders)
  - `src/email/templates/templates.spec.ts`
- Test: `src/email/templates/templates.spec.ts`

**Interfaces:**
- Consumes: everything.
- Produces: no new interface.

Steps:

- [ ] **Step 1: Add the completeness test.** Write the test, then run it and expect PASS if T6–T16 are merged; a FAIL lists the missing ids.

```ts
it('every TEMPLATE_ID is registered', () => expect(ALL_TEMPLATES.map((d) => d.id).sort()).toEqual([...TEMPLATE_IDS].sort()));
it('no template or EmailService string contains yourdomain or "Social Media Automation"', ...); // read src/email/**/*.ts(x) as text
it('every notification-footer template has an event and every event-less template a non-notification footer', ...);
it('every def.event is a key of NOTIFICATION_EVENTS', ...);
```

- [ ] **Step 2: Delete the dead code.** Check `grep -rn "yourdomain\|sendVerificationEmail\|sendDripNotification\|sendWorkspaceInvitation" src`. Expected: no hits outside specs that assert absence.
- [ ] **Step 3: Full verification:**
  - `npx jest` (all unit specs). Expected: PASS.
  - The DB specs `npx jest "\.db\.spec\.ts$" --runInBand`, with the DB env from Global Constraints. Expected: PASS.
  - `npx tsc --noEmit -p tsconfig.json`. Expected: 35 errors, all in untouched files.
  - `npm run build`. Expected: exit 0.
  - `npm run email:preview`. Expected: 29 base files plus variants, and `index.html` lists them.
- [ ] **Step 4: Commit** `chore(email): remove legacy email builders; template completeness test`.
- [ ] **Step 5: Hand off for the FE browser checks** (FE plan Task 3). Copy `email-previews/` to `C:\Users\hp\AppData\Local\Temp\claude\b7bac591966eb68a\d4116103-65ee-4103-9aab-04bc02362fb0\scratchpad\email-previews\`.
