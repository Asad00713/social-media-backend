# WhatsApp Embedded Signup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect a WhatsApp Business Account through our app's Facebook Login for Business consent dialog (Embedded Signup v4) so the `whatsapp_business_messaging` + `whatsapp_business_management` permissions are demo-able for Meta App Review, while keeping the manual token connect as a hidden "Advanced" fallback.

**Architecture:** The browser loads the Facebook JS SDK on demand and calls `FB.login` with our `config_id`; a `WA_EMBEDDED_SIGNUP` `message` event yields `waba_id` + `phone_number_id` and the callback yields a 30-second `code`. The frontend POSTs these to a new backend endpoint, which exchanges the code for a business token, registers the phone number, subscribes our app to the WABA, guards against cross-workspace duplicates, then persists via the existing `createChannel` (which fires the analytics/backfill lifecycle).

**Tech Stack:** Backend NestJS + Drizzle + Jest (`socialmedia-workspace`). Frontend Vite + React 19 + shadcn (`socialmedia-frontend`, no unit-test runner — verify via `npm run build` + manual smoke).

## Global Constraints

- Graph API version pinned to `v21.0` via a single `GRAPH_API_VERSION` const in `whatsapp.service.ts`; all new WhatsApp Graph calls derive from it. Do NOT touch `facebook.service.ts`'s v18 (out of scope).
- Access token encrypted at rest via the existing `createChannel` path (`encrypt()` in `common/utils/encryption.util.ts`). Never log the token or the exchange `code`.
- Frontend UI is shadcn-only with theme tokens (`bg-background`, `text-muted-foreground`, etc.). No hard-coded colors except the existing WhatsApp brand accent already in the dialog (`bg-emerald-500/10`).
- Client-side only ever sees the public `META_APP_ID` and `config_id`.
- Webhook signature verification stays fail-closed — not touched by this plan.
- Keep the existing manual connect endpoint `POST /channels/workspaces/:workspaceId/whatsapp/connect` and its dialog form working.
- Backend TDD (Jest). Frontend has no test runner: each frontend task's verification step is `npm run build` (tsc) plus a stated manual check.

---

## File Structure

**Backend (`socialmedia-workspace`):**
- Modify `src/channels/services/whatsapp.service.ts` — add `GRAPH_API_VERSION` const + 3 Graph methods.
- Modify `src/channels/services/channel.service.ts` — add cross-workspace lookup helper.
- Modify `src/inbox/inbox.service.ts` — make `findChannelByPlatformAccount` deterministic + warn on multi-row.
- Create `src/channels/dto/embedded-signup-whatsapp.dto.ts` — request DTO.
- Create `src/channels/services/whatsapp-onboarding.service.ts` — Embedded Signup orchestration.
- Modify `src/channels/channels.controller.ts` — thin `POST .../whatsapp/embedded-signup` endpoint.
- Modify `src/channels/channels.module.ts` — register `WhatsAppOnboardingService`.
- Modify `.env.example` — document `META_APP_ID`.
- Tests: `whatsapp.service.spec.ts`, `whatsapp-onboarding.service.spec.ts`, `inbox.service`'s existing spec (or a focused new spec).

**Frontend (`socialmedia-frontend`):**
- Modify `src/features/channels/api/whatsapp.api.ts` — add `embeddedSignup`.
- Create `src/features/channels/utils/load-facebook-sdk.ts` — lazy SDK loader + FB types.
- Create `src/features/channels/hooks/use-whatsapp-embedded-signup.ts` — orchestration hook.
- Create `src/features/channels/components/whatsapp-embedded-signup-button.tsx` — the CTA.
- Modify `src/features/channels/components/whatsapp-connect-dialog.tsx` — primary ES button + Collapsible manual form.
- Modify `.env.example` — `VITE_META_APP_ID`, `VITE_WHATSAPP_ES_CONFIG_ID`.

---

## Task 1: Backend — WhatsApp Graph methods for Embedded Signup

**Files:**
- Modify: `src/channels/services/whatsapp.service.ts`
- Test: `src/channels/services/whatsapp.service.spec.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: existing `WhatsAppService` (methods `sendText`, `subscribeWaba`, etc.), `process.env.META_APP_ID`, `process.env.META_APP_SECRET`.
- Produces:
  - `GRAPH_API_VERSION = 'v21.0'` (exported const)
  - `exchangeCodeForBusinessToken(code: string): Promise<{ accessToken: string; expiresIn: number | null }>`
  - `registerPhoneNumber(accessToken: string, phoneNumberId: string, pin: string): Promise<void>` (treats "already registered" as success)
  - `getWabaPhoneNumbers(accessToken: string, wabaId: string): Promise<Array<{ id: string; displayPhoneNumber: string | null; verifiedName: string | null }>>`

- [ ] **Step 1: Write failing tests**

Add to `src/channels/services/whatsapp.service.spec.ts` (create the file if it does not exist, following the existing service-spec style; mock `global.fetch`):

```ts
import { WhatsAppService, GRAPH_API_VERSION } from './whatsapp.service';

describe('WhatsAppService — Embedded Signup Graph methods', () => {
  let service: WhatsAppService;
  const OLD_ENV = process.env;

  beforeEach(() => {
    service = new WhatsAppService();
    process.env = { ...OLD_ENV, META_APP_ID: 'app123', META_APP_SECRET: 'secret456' };
    global.fetch = jest.fn();
  });
  afterEach(() => {
    process.env = OLD_ENV;
    jest.resetAllMocks();
  });

  it('pins Graph API version to v21.0', () => {
    expect(GRAPH_API_VERSION).toBe('v21.0');
  });

  it('exchangeCodeForBusinessToken hits oauth/access_token with app creds + code', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'biz-token', expires_in: 5184000 }),
    });
    const res = await service.exchangeCodeForBusinessToken('the-code');
    expect(res).toEqual({ accessToken: 'biz-token', expiresIn: 5184000 });
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain(`/${GRAPH_API_VERSION}/oauth/access_token`);
    expect(url).toContain('client_id=app123');
    expect(url).toContain('client_secret=secret456');
    expect(url).toContain('code=the-code');
  });

  it('exchangeCodeForBusinessToken returns null expiresIn when Meta omits it (never-expiring config)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'biz-token' }),
    });
    const res = await service.exchangeCodeForBusinessToken('c');
    expect(res).toEqual({ accessToken: 'biz-token', expiresIn: null });
  });

  it('exchangeCodeForBusinessToken throws the Meta error message on failure', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Invalid code' } }),
    });
    await expect(service.exchangeCodeForBusinessToken('bad')).rejects.toThrow('Invalid code');
  });

  it('registerPhoneNumber posts messaging_product + pin', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    await service.registerPhoneNumber('tok', '111', '123456');
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}/111/register`);
    expect(JSON.parse((init as any).body)).toEqual({ messaging_product: 'whatsapp', pin: '123456' });
  });

  it('registerPhoneNumber treats "already registered" as success', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Phone number already registered', code: 100 } }),
    });
    await expect(service.registerPhoneNumber('tok', '111', '123456')).resolves.toBeUndefined();
  });

  it('registerPhoneNumber throws on a genuine failure', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Two-step verification pin mismatch' } }),
    });
    await expect(service.registerPhoneNumber('tok', '111', '000000')).rejects.toThrow(
      'Two-step verification pin mismatch',
    );
  });

  it('getWabaPhoneNumbers maps the Graph response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: '111', display_phone_number: '+1 555', verified_name: 'Acme' },
          { id: '222', display_phone_number: null, verified_name: null },
        ],
      }),
    });
    const res = await service.getWabaPhoneNumbers('tok', 'waba1');
    expect(res).toEqual([
      { id: '111', displayPhoneNumber: '+1 555', verifiedName: 'Acme' },
      { id: '222', displayPhoneNumber: null, verifiedName: null },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd socialmedia-workspace && npm run test -- whatsapp.service`
Expected: FAIL — `GRAPH_API_VERSION` / new methods are undefined.

- [ ] **Step 3: Implement the methods**

In `src/channels/services/whatsapp.service.ts`, replace the top const and add the methods. Change line 3:

```ts
export const GRAPH_API_VERSION = 'v21.0';
export const WHATSAPP_GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
```

Add these methods inside the `WhatsAppService` class (e.g. after `subscribeWaba`):

```ts
  /**
   * Exchange the short-lived Embedded Signup code (valid ~30s) for a
   * customer-scoped business access token. Tech Provider server-to-server call.
   */
  async exchangeCodeForBusinessToken(
    code: string,
  ): Promise<{ accessToken: string; expiresIn: number | null }> {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) {
      throw new Error('META_APP_ID / META_APP_SECRET are not configured');
    }
    const url =
      `${WHATSAPP_GRAPH_BASE}/oauth/access_token` +
      `?client_id=${encodeURIComponent(appId)}` +
      `&client_secret=${encodeURIComponent(appSecret)}` +
      `&code=${encodeURIComponent(code)}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.access_token) {
      const msg = data?.error?.message || `Code exchange failed (${res.status})`;
      throw new Error(msg);
    }
    return {
      accessToken: data.access_token as string,
      expiresIn: typeof data.expires_in === 'number' ? data.expires_in : null,
    };
  }

  /**
   * Register the customer's business phone number for Cloud API use. `pin` is
   * the 6-digit two-step-verification PIN. If the number is already registered
   * (idempotent re-run) we treat it as success.
   */
  async registerPhoneNumber(
    accessToken: string,
    phoneNumberId: string,
    pin: string,
  ): Promise<void> {
    const res = await fetch(`${WHATSAPP_GRAPH_BASE}/${phoneNumberId}/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return;
    const msg = (data?.error?.message as string) || '';
    if (/already\s+registered/i.test(msg)) return; // idempotent
    throw new Error(msg || `Phone number register failed (${res.status})`);
  }

  /**
   * List the phone numbers on a WABA — fallback when the Embedded Signup
   * message event omits the phone_number_id, and to read verified_name.
   */
  async getWabaPhoneNumbers(
    accessToken: string,
    wabaId: string,
  ): Promise<
    Array<{ id: string; displayPhoneNumber: string | null; verifiedName: string | null }>
  > {
    const res = await fetch(
      `${WHATSAPP_GRAPH_BASE}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || `WABA phone lookup failed (${res.status})`;
      throw new Error(msg);
    }
    return ((data?.data as any[]) ?? []).map((p) => ({
      id: String(p.id),
      displayPhoneNumber: p.display_phone_number ?? null,
      verifiedName: p.verified_name ?? null,
    }));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd socialmedia-workspace && npm run test -- whatsapp.service`
Expected: PASS (all cases green).

- [ ] **Step 5: Document env**

In `.env.example`, near `META_APP_SECRET`, add:

```
# Meta app id (public) — needed for WhatsApp Embedded Signup code exchange
META_APP_ID=
```

- [ ] **Step 6: Build + commit**

Run: `cd socialmedia-workspace && npm run build`
Expected: no errors.

```bash
git add src/channels/services/whatsapp.service.ts src/channels/services/whatsapp.service.spec.ts .env.example
git commit -m "feat(whatsapp): Graph methods for Embedded Signup (exchange/register/list phones)"
```

---

## Task 2: Backend — multi-tenant correctness (cross-workspace guard + deterministic lookup)

**Files:**
- Modify: `src/channels/services/channel.service.ts` — add `findChannelsByPlatformAccountAllWorkspaces`.
- Modify: `src/inbox/inbox.service.ts:1842` — make `findChannelByPlatformAccount` deterministic + warn.
- Test: `src/channels/services/channel.service.spec.ts` (create/extend, focused).

**Interfaces:**
- Consumes: `db`, `socialMediaChannels`, `SupportedPlatform`.
- Produces on `ChannelService`:
  - `findChannelsByPlatformAccountAllWorkspaces(platform: SupportedPlatform, platformAccountId: string): Promise<Array<{ id: number; workspaceId: string }>>`
- `InboxService.findChannelByPlatformAccount` unchanged signature, now deterministic (lowest `id` first) and logs a warning when more than one row matches.

- [ ] **Step 1: Write failing test (channel.service)**

Create `src/channels/services/channel.service.spec.ts` (or add a `describe` block if it exists) that mocks the drizzle `db` used by the service and asserts the query filters on `(platform, platformAccountId)` across workspaces. Because the service imports a module-level `db`, mock it via `jest.mock`:

```ts
import { ChannelService } from './channel.service';

// Minimal fake db that records the query builder chain and returns canned rows.
const rows = [
  { id: 7, workspaceId: 'ws-A' },
  { id: 3, workspaceId: 'ws-B' },
];
jest.mock('../../drizzle/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(rows),
        }),
      }),
    }),
  },
}));

describe('ChannelService.findChannelsByPlatformAccountAllWorkspaces', () => {
  it('returns every workspace holding this platform account', async () => {
    // Construct the service with its other deps stubbed as needed for this method.
    const service = new ChannelService({} as any, {} as any, {} as any);
    const res = await service.findChannelsByPlatformAccountAllWorkspaces(
      'whatsapp',
      '111',
    );
    expect(res).toEqual(rows);
  });
});
```

> Note: match the actual `db` import path used in `channel.service.ts` (check the import at the top — it may be `../../drizzle/drizzle.module` or a `db` export). Adjust the `jest.mock` target and the `ChannelService` constructor arguments to the real dependency list. Keep the assertion (returns all matching rows) intact.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd socialmedia-workspace && npm run test -- channel.service`
Expected: FAIL — method undefined.

- [ ] **Step 3: Implement the helper**

Add to `ChannelService` (use the same `db` + `asc` import style already in the file; import `asc` from `drizzle-orm` if not present):

```ts
  /**
   * Every channel row (across ALL workspaces) that holds this platform account.
   * Used by WhatsApp Embedded Signup to reject connecting a phone number that
   * another workspace already owns (webhook routing is keyed on the account id).
   */
  async findChannelsByPlatformAccountAllWorkspaces(
    platform: SupportedPlatform,
    platformAccountId: string,
  ): Promise<Array<{ id: number; workspaceId: string }>> {
    return db
      .select({
        id: socialMediaChannels.id,
        workspaceId: socialMediaChannels.workspaceId,
      })
      .from(socialMediaChannels)
      .where(
        and(
          eq(socialMediaChannels.platform, platform),
          eq(socialMediaChannels.platformAccountId, platformAccountId),
        ),
      )
      .orderBy(asc(socialMediaChannels.id));
  }
```

- [ ] **Step 4: Make the inbox lookup deterministic**

In `src/inbox/inbox.service.ts`, replace `findChannelByPlatformAccount` (line ~1842):

```ts
  async findChannelByPlatformAccount(
    platform: SupportedPlatform,
    platformAccountId: string,
  ) {
    const matches = await db.query.socialMediaChannels.findMany({
      where: and(
        eq(socialMediaChannels.platform, platform),
        eq(socialMediaChannels.platformAccountId, platformAccountId),
      ),
      orderBy: (c, { asc }) => asc(c.id),
    });
    if (matches.length > 1) {
      this.logger.warn(
        `findChannelByPlatformAccount: ${matches.length} rows for ${platform}/${platformAccountId} — routing to the lowest channel id (${matches[0].id}). This should not happen; a cross-workspace duplicate slipped past the connect guard.`,
      );
    }
    return matches[0];
  }
```

> Confirm `InboxService` has a `private readonly logger` (Nest `Logger`). If not, add `private readonly logger = new Logger(InboxService.name);` and import `Logger` from `@nestjs/common`.

- [ ] **Step 5: Run tests + build**

Run: `cd socialmedia-workspace && npm run test -- channel.service && npm run build`
Expected: PASS + no build errors.

- [ ] **Step 6: Commit**

```bash
git add src/channels/services/channel.service.ts src/channels/services/channel.service.spec.ts src/inbox/inbox.service.ts
git commit -m "fix(whatsapp): cross-workspace lookup + deterministic channel routing"
```

---

## Task 3: Backend — Embedded Signup orchestration service + endpoint

**Files:**
- Create: `src/channels/dto/embedded-signup-whatsapp.dto.ts`
- Create: `src/channels/services/whatsapp-onboarding.service.ts`
- Test: `src/channels/services/whatsapp-onboarding.service.spec.ts`
- Modify: `src/channels/channels.controller.ts` — add endpoint.
- Modify: `src/channels/channels.module.ts` — register the service.

**Interfaces:**
- Consumes: `WhatsAppService` (Task 1), `ChannelService` (Task 2 helper + `createChannel`), `InboxService.assertWorkspaceAccessPublic`.
- Produces:
  - DTO `EmbeddedSignupWhatsAppDto { code: string; wabaId: string; phoneNumberId: string; pin?: string }`
  - `WhatsAppOnboardingService.completeEmbeddedSignup(workspaceId: string, userId: string, input: { code: string; wabaId: string; phoneNumberId: string; pin?: string }): Promise<ChannelResponseDto>`
  - `POST /channels/workspaces/:workspaceId/whatsapp/embedded-signup`

- [ ] **Step 1: Write the DTO**

Create `src/channels/dto/embedded-signup-whatsapp.dto.ts`:

```ts
import { IsString, IsNotEmpty, IsOptional, Matches } from 'class-validator';

export class EmbeddedSignupWhatsAppDto {
  // Short-lived exchangeable code from the Embedded Signup callback (~30s TTL).
  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\d+$/, { message: 'wabaId must be a numeric id' })
  wabaId!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\d+$/, { message: 'phoneNumberId must be a numeric id' })
  phoneNumberId!: string;

  // 6-digit two-step-verification PIN used to register the number. Defaults to
  // '000000' when the number has no two-step PIN set.
  @IsString()
  @IsOptional()
  @Matches(/^\d{6}$/, { message: 'pin must be 6 digits' })
  pin?: string;
}
```

- [ ] **Step 2: Write failing tests for the orchestration service**

Create `src/channels/services/whatsapp-onboarding.service.spec.ts`:

```ts
import { ConflictException, BadRequestException } from '@nestjs/common';
import { WhatsAppOnboardingService } from './whatsapp-onboarding.service';

function makeService(overrides: {
  whatsapp?: Partial<any>;
  channels?: Partial<any>;
  inbox?: Partial<any>;
} = {}) {
  const whatsapp = {
    exchangeCodeForBusinessToken: jest.fn().mockResolvedValue({ accessToken: 'biz', expiresIn: 5184000 }),
    getWabaPhoneNumbers: jest.fn().mockResolvedValue([
      { id: '111', displayPhoneNumber: '+1 555', verifiedName: 'Acme' },
    ]),
    registerPhoneNumber: jest.fn().mockResolvedValue(undefined),
    subscribeWaba: jest.fn().mockResolvedValue(undefined),
    ...overrides.whatsapp,
  };
  const channels = {
    findChannelsByPlatformAccountAllWorkspaces: jest.fn().mockResolvedValue([]),
    createChannel: jest.fn().mockResolvedValue({ id: 1, accountName: 'Acme' }),
    ...overrides.channels,
  };
  const inbox = {
    assertWorkspaceAccessPublic: jest.fn().mockResolvedValue(undefined),
    ...overrides.inbox,
  };
  const service = new WhatsAppOnboardingService(whatsapp as any, channels as any, inbox as any);
  return { service, whatsapp, channels, inbox };
}

describe('WhatsAppOnboardingService.completeEmbeddedSignup', () => {
  const input = { code: 'c', wabaId: 'w1', phoneNumberId: '111' };

  it('runs the full happy path and creates the channel', async () => {
    const { service, whatsapp, channels } = makeService();
    const res = await service.completeEmbeddedSignup('ws-A', 'u1', input);
    expect(whatsapp.exchangeCodeForBusinessToken).toHaveBeenCalledWith('c');
    expect(whatsapp.registerPhoneNumber).toHaveBeenCalledWith('biz', '111', '000000');
    expect(whatsapp.subscribeWaba).toHaveBeenCalledWith('biz', 'w1');
    expect(channels.createChannel).toHaveBeenCalledWith(
      'ws-A',
      'u1',
      expect.objectContaining({
        platform: 'whatsapp',
        platformAccountId: '111',
        accessToken: 'biz',
        metadata: expect.objectContaining({ wabaId: 'w1', connectMethod: 'embedded_signup' }),
      }),
    );
    expect(res).toEqual({ id: 1, accountName: 'Acme' });
  });

  it('passes a caller-supplied pin through to register', async () => {
    const { service, whatsapp } = makeService();
    await service.completeEmbeddedSignup('ws-A', 'u1', { ...input, pin: '654321' });
    expect(whatsapp.registerPhoneNumber).toHaveBeenCalledWith('biz', '111', '654321');
  });

  it('rejects when the phone number is already connected in another workspace', async () => {
    const { service } = makeService({
      channels: {
        findChannelsByPlatformAccountAllWorkspaces: jest
          .fn()
          .mockResolvedValue([{ id: 9, workspaceId: 'ws-OTHER' }]),
      },
    });
    await expect(
      service.completeEmbeddedSignup('ws-A', 'u1', input),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows re-connecting a number already in the SAME workspace (delegates to createChannel)', async () => {
    const { service, channels } = makeService({
      channels: {
        findChannelsByPlatformAccountAllWorkspaces: jest
          .fn()
          .mockResolvedValue([{ id: 9, workspaceId: 'ws-A' }]),
        createChannel: jest.fn().mockResolvedValue({ id: 9, accountName: 'Acme' }),
      },
    });
    const res = await service.completeEmbeddedSignup('ws-A', 'u1', input);
    expect(res).toEqual({ id: 9, accountName: 'Acme' });
    expect(channels.createChannel).toHaveBeenCalled();
  });

  it('surfaces an expired/invalid code as a BadRequest', async () => {
    const { service } = makeService({
      whatsapp: {
        exchangeCodeForBusinessToken: jest.fn().mockRejectedValue(new Error('Invalid code')),
      },
    });
    await expect(
      service.completeEmbeddedSignup('ws-A', 'u1', input),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fails the connect when WABA subscribe fails (blocking, not best-effort)', async () => {
    const { service } = makeService({
      whatsapp: {
        subscribeWaba: jest.fn().mockRejectedValue(new Error('subscribe boom')),
      },
    });
    await expect(
      service.completeEmbeddedSignup('ws-A', 'u1', input),
    ).rejects.toThrow('subscribe boom');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd socialmedia-workspace && npm run test -- whatsapp-onboarding`
Expected: FAIL — service does not exist.

- [ ] **Step 4: Implement the orchestration service**

Create `src/channels/services/whatsapp-onboarding.service.ts`:

```ts
import {
  Injectable,
  Logger,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { ChannelService } from './channel.service';
import { InboxService } from '../../inbox/inbox.service';
import type { ChannelResponseDto } from '../dto/channel.dto';

export interface EmbeddedSignupInput {
  code: string;
  wabaId: string;
  phoneNumberId: string;
  pin?: string;
}

@Injectable()
export class WhatsAppOnboardingService {
  private readonly logger = new Logger(WhatsAppOnboardingService.name);

  constructor(
    private readonly whatsapp: WhatsAppService,
    private readonly channels: ChannelService,
    private readonly inbox: InboxService,
  ) {}

  /**
   * Complete WhatsApp Embedded Signup (Tech Provider flow): exchange the code
   * for a business token, register the phone number, subscribe our app to the
   * WABA, guard cross-workspace duplicates, then persist the channel.
   */
  async completeEmbeddedSignup(
    workspaceId: string,
    userId: string,
    input: EmbeddedSignupInput,
  ): Promise<ChannelResponseDto> {
    await this.inbox.assertWorkspaceAccessPublic(workspaceId, userId);

    // 1. Exchange the short-lived code for a customer-scoped business token.
    let accessToken: string;
    let expiresIn: number | null;
    try {
      const exchanged = await this.whatsapp.exchangeCodeForBusinessToken(input.code);
      accessToken = exchanged.accessToken;
      expiresIn = exchanged.expiresIn;
    } catch (err) {
      throw new BadRequestException(
        `Could not complete WhatsApp signup — ${
          (err as Error).message
        }. The signup code expires within ~30 seconds; please try connecting again.`,
      );
    }

    // 2. Resolve display name / verified name (also validates the number).
    let displayPhoneNumber: string | null = null;
    let verifiedName: string | null = null;
    try {
      const phones = await this.whatsapp.getWabaPhoneNumbers(accessToken, input.wabaId);
      const match = phones.find((p) => p.id === input.phoneNumberId) ?? phones[0];
      displayPhoneNumber = match?.displayPhoneNumber ?? null;
      verifiedName = match?.verifiedName ?? null;
    } catch (err) {
      this.logger.warn(
        `getWabaPhoneNumbers failed for waba=${input.wabaId}: ${(err as Error).message}`,
      );
    }

    // 3. Register the phone number for Cloud API (idempotent).
    await this.whatsapp.registerPhoneNumber(
      accessToken,
      input.phoneNumberId,
      input.pin ?? '000000',
    );

    // 4. Subscribe our app to the WABA — BLOCKING. A channel that never
    //    receives webhooks is worse than a visible failure.
    await this.whatsapp.subscribeWaba(accessToken, input.wabaId);

    // 5. Cross-workspace guard: reject if this phone number is already owned by
    //    a DIFFERENT workspace (webhook routing is keyed on phone_number_id).
    const existing =
      await this.channels.findChannelsByPlatformAccountAllWorkspaces(
        'whatsapp',
        input.phoneNumberId,
      );
    const otherWorkspace = existing.find((c) => c.workspaceId !== workspaceId);
    if (otherWorkspace) {
      throw new ConflictException(
        'This WhatsApp number is already connected to another workspace. Disconnect it there first.',
      );
    }

    // 6. Persist. createChannel encrypts the token and, for a same-workspace
    //    broken row, reconnects in place (a healthy same-workspace duplicate
    //    still throws ConflictException — expected).
    const accountName = verifiedName || input.phoneNumberId;
    return this.channels.createChannel(workspaceId, userId, {
      platform: 'whatsapp',
      accountType: 'business_account',
      platformAccountId: input.phoneNumberId,
      accountName,
      accessToken,
      tokenExpiresAt: expiresIn
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : undefined,
      metadata: {
        wabaId: input.wabaId,
        displayPhoneNumber: displayPhoneNumber ?? input.phoneNumberId,
        connectMethod: 'embedded_signup',
      },
    });
  }
}
```

> Verify `CreateChannelDto` accepts `tokenExpiresAt` as an ISO string (Task 2 read of `channel.service.ts` shows `dto.tokenExpiresAt` is passed to `new Date(...)`). If `CreateChannelDto` types it differently, match that type. If `ChannelResponseDto` import path differs, correct it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd socialmedia-workspace && npm run test -- whatsapp-onboarding`
Expected: PASS.

- [ ] **Step 6: Add the controller endpoint**

In `src/channels/channels.controller.ts`: import the DTO + service, inject the service in the constructor, and add the endpoint next to `connectWhatsApp` (after line 5442, inside the class):

```ts
  @Post('workspaces/:workspaceId/whatsapp/embedded-signup')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async connectWhatsAppEmbeddedSignup(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: EmbeddedSignupWhatsAppDto,
    @CurrentUser() user: { userId: string; email: string },
  ) {
    return this.whatsappOnboardingService.completeEmbeddedSignup(
      workspaceId,
      user.userId,
      {
        code: dto.code,
        wabaId: dto.wabaId,
        phoneNumberId: dto.phoneNumberId,
        pin: dto.pin,
      },
    );
  }
```

Add the import near the other DTO imports:
```ts
import { EmbeddedSignupWhatsAppDto } from './dto/embedded-signup-whatsapp.dto';
import { WhatsAppOnboardingService } from './services/whatsapp-onboarding.service';
```
Add to the constructor parameter list:
```ts
    private readonly whatsappOnboardingService: WhatsAppOnboardingService,
```

- [ ] **Step 7: Register the service in the module**

In `src/channels/channels.module.ts`, add `WhatsAppOnboardingService` to the `providers` array (import it at the top). Ensure `InboxService` is available to it — if `ChannelsModule` does not already import the module that exports `InboxService`, add that import (check how `channels.controller.ts` already uses `inboxService` — the wiring already exists, so the provider is reachable).

- [ ] **Step 8: Build + commit**

Run: `cd socialmedia-workspace && npm run build && npm run test -- whatsapp`
Expected: no build errors, all whatsapp tests pass.

```bash
git add src/channels/dto/embedded-signup-whatsapp.dto.ts src/channels/services/whatsapp-onboarding.service.ts src/channels/services/whatsapp-onboarding.service.spec.ts src/channels/channels.controller.ts src/channels/channels.module.ts
git commit -m "feat(whatsapp): Embedded Signup onboarding service + endpoint"
```

---

## Task 4: Frontend — API + Facebook SDK loader + orchestration hook

**Files:**
- Modify: `src/features/channels/api/whatsapp.api.ts`
- Create: `src/features/channels/utils/load-facebook-sdk.ts`
- Create: `src/features/channels/hooks/use-whatsapp-embedded-signup.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `apiClient`, `ChannelDto`, `import.meta.env.VITE_META_APP_ID`, `import.meta.env.VITE_WHATSAPP_ES_CONFIG_ID`.
- Produces:
  - `whatsappApi.embeddedSignup(workspaceId, { code, wabaId, phoneNumberId })`
  - `loadFacebookSdk(appId: string): Promise<FacebookSdk>`
  - `useWhatsAppEmbeddedSignup()` → `{ start(): void; status: 'idle'|'loading'|'connecting'|'error'; error: string | null }`

- [ ] **Step 1: Add the API function**

In `src/features/channels/api/whatsapp.api.ts`, add:

```ts
export interface EmbeddedSignupWhatsAppPayload {
  code: string
  wabaId: string
  phoneNumberId: string
}
```
and inside `whatsappApi`:
```ts
  embeddedSignup: (workspaceId: string, payload: EmbeddedSignupWhatsAppPayload) =>
    apiClient.post<ChannelDto>(
      `/channels/workspaces/${workspaceId}/whatsapp/embedded-signup`,
      payload,
    ),
```

- [ ] **Step 2: Create the SDK loader**

Create `src/features/channels/utils/load-facebook-sdk.ts`:

```ts
// Minimal typing for the pieces of the Facebook JS SDK we use.
export interface FacebookAuthResponse {
  code?: string
}
export interface FacebookLoginResponse {
  authResponse: FacebookAuthResponse | null
  status: string
}
export interface FacebookSdk {
  init(params: { appId: string; autoLogAppEvents?: boolean; xfbml?: boolean; version: string }): void
  login(
    cb: (response: FacebookLoginResponse) => void,
    options: {
      config_id: string
      response_type: 'code'
      override_default_response_type: boolean
      extras: { setup: Record<string, unknown> }
    },
  ): void
}

declare global {
  interface Window {
    FB?: FacebookSdk
    fbAsyncInit?: () => void
  }
}

const SDK_SRC = 'https://connect.facebook.net/en_US/sdk.js'
const GRAPH_VERSION = 'v21.0'
let sdkPromise: Promise<FacebookSdk> | null = null

/** Lazily inject + init the Facebook JS SDK exactly once. */
export function loadFacebookSdk(appId: string): Promise<FacebookSdk> {
  if (sdkPromise) return sdkPromise
  sdkPromise = new Promise<FacebookSdk>((resolve, reject) => {
    if (window.FB) {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version: GRAPH_VERSION })
      resolve(window.FB)
      return
    }
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version: GRAPH_VERSION })
      resolve(window.FB!)
    }
    const script = document.createElement('script')
    script.src = SDK_SRC
    script.async = true
    script.defer = true
    script.crossOrigin = 'anonymous'
    script.onerror = () => {
      sdkPromise = null
      reject(new Error('Could not load the Facebook SDK. Check your connection and retry.'))
    }
    document.body.appendChild(script)
  })
  return sdkPromise
}
```

- [ ] **Step 3: Create the orchestration hook**

Create `src/features/channels/hooks/use-whatsapp-embedded-signup.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { useWorkspaceId } from '@/hooks/use-workspace-id'
import { queryKeys } from '@/lib/query-client'
import { loadFacebookSdk } from '../utils/load-facebook-sdk'
import { whatsappApi } from '../api/whatsapp.api'

type Status = 'idle' | 'loading' | 'connecting' | 'error'

interface EmbeddedSignupSessionData {
  phone_number_id?: string
  waba_id?: string
  business_id?: string
  current_step?: string
  error_message?: string
}

interface UseWhatsAppEmbeddedSignupResult {
  start: () => void
  status: Status
  error: string | null
}

const APP_ID = import.meta.env.VITE_META_APP_ID as string | undefined
const CONFIG_ID = import.meta.env.VITE_WHATSAPP_ES_CONFIG_ID as string | undefined

export function useWhatsAppEmbeddedSignup(
  onConnected?: () => void,
): UseWhatsAppEmbeddedSignupResult {
  const workspaceId = useWorkspaceId()
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  // Captured from the WA_EMBEDDED_SIGNUP message event; paired with the code
  // from the FB.login callback.
  const sessionRef = useRef<EmbeddedSignupSessionData | null>(null)

  const submit = useMutation({
    mutationFn: (payload: { code: string; wabaId: string; phoneNumberId: string }) => {
      if (!workspaceId) throw new Error('No active workspace')
      return whatsappApi.embeddedSignup(workspaceId, payload)
    },
    onSuccess: async (channel) => {
      setStatus('idle')
      toast.success('WhatsApp connected', {
        description: channel.accountName ? `Linked ${channel.accountName}` : undefined,
      })
      if (workspaceId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.channels.list(workspaceId) })
      }
      onConnected?.()
    },
    onError: (err) => {
      setStatus('error')
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not finish connecting WhatsApp. Please try again.',
      )
    },
  })

  // Listen for the Embedded Signup session events (origin: facebook.com).
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!event.origin.endsWith('facebook.com')) return
      let parsed: { type?: string; event?: string; data?: EmbeddedSignupSessionData }
      try {
        parsed = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
      } catch {
        return
      }
      if (parsed?.type !== 'WA_EMBEDDED_SIGNUP') return
      if (parsed.event === 'FINISH' || parsed.event === 'FINISH_ONLY_WABA') {
        sessionRef.current = parsed.data ?? null
      } else if (parsed.event === 'CANCEL') {
        setStatus('idle')
        setError(
          parsed.data?.current_step
            ? `Signup was cancelled at "${parsed.data.current_step}". You can try again.`
            : null,
        )
      } else if (parsed.event === 'ERROR') {
        setStatus('error')
        setError(parsed.data?.error_message ?? 'WhatsApp signup returned an error.')
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const start = useCallback(() => {
    setError(null)
    if (!APP_ID || !CONFIG_ID) {
      setStatus('error')
      setError('WhatsApp signup is not configured (missing app id / config id).')
      return
    }
    setStatus('loading')
    sessionRef.current = null
    loadFacebookSdk(APP_ID)
      .then((FB) => {
        setStatus('connecting')
        FB.login(
          (response) => {
            const code = response.authResponse?.code
            const session = sessionRef.current
            if (!code || !session?.waba_id || !session?.phone_number_id) {
              // User closed the dialog or abandoned before finishing.
              setStatus((s) => (s === 'error' ? s : 'idle'))
              return
            }
            submit.mutate({
              code,
              wabaId: session.waba_id,
              phoneNumberId: session.phone_number_id,
            })
          },
          {
            config_id: CONFIG_ID,
            response_type: 'code',
            override_default_response_type: true,
            extras: { setup: {} },
          },
        )
      })
      .catch((err: Error) => {
        setStatus('error')
        setError(err.message)
      })
  }, [submit])

  return {
    start,
    status: submit.isPending ? 'connecting' : status,
    error,
  }
}
```

- [ ] **Step 4: Document env**

In `.env.example` (frontend), add:
```
# Meta app id (public) for WhatsApp Embedded Signup
VITE_META_APP_ID=
# Facebook Login for Business configuration id for WhatsApp Embedded Signup
VITE_WHATSAPP_ES_CONFIG_ID=
```

- [ ] **Step 5: Verify build**

Run: `cd socialmedia-frontend && npm run build`
Expected: tsc + vite build succeed (no type errors from the new files).

- [ ] **Step 6: Commit**

```bash
git add src/features/channels/api/whatsapp.api.ts src/features/channels/utils/load-facebook-sdk.ts src/features/channels/hooks/use-whatsapp-embedded-signup.ts .env.example
git commit -m "feat(whatsapp): frontend Embedded Signup SDK loader + hook + api"
```

---

## Task 5: Frontend — Embedded Signup button + dialog restructure

**Files:**
- Create: `src/features/channels/components/whatsapp-embedded-signup-button.tsx`
- Modify: `src/features/channels/components/whatsapp-connect-dialog.tsx`

**Interfaces:**
- Consumes: `useWhatsAppEmbeddedSignup` (Task 4), shadcn `Button`, `Collapsible` (`src/components/ui/collapsible.tsx` — already installed).
- Produces: `<WhatsAppEmbeddedSignupButton onConnected={...} />`.

- [ ] **Step 1: Create the button component**

Create `src/features/channels/components/whatsapp-embedded-signup-button.tsx`:

```tsx
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useWhatsAppEmbeddedSignup } from '../hooks/use-whatsapp-embedded-signup'

interface WhatsAppEmbeddedSignupButtonProps {
  onConnected: () => void
}

export function WhatsAppEmbeddedSignupButton({
  onConnected,
}: WhatsAppEmbeddedSignupButtonProps) {
  const { start, status, error } = useWhatsAppEmbeddedSignup(onConnected)
  const isBusy = status === 'loading' || status === 'connecting'

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" onClick={start} disabled={isBusy} className="w-full">
        {isBusy ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            {status === 'loading' ? 'Opening Facebook…' : 'Connecting…'}
          </>
        ) : (
          'Connect with Facebook'
        )}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        You'll be asked to select your WhatsApp Business account and grant access.
      </p>
      {error && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Restructure the dialog**

In `src/features/channels/components/whatsapp-connect-dialog.tsx`:

1. Add imports:
```tsx
import { ChevronsUpDown } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { WhatsAppEmbeddedSignupButton } from './whatsapp-embedded-signup-button'
```
2. Add a state for the advanced disclosure inside the component:
```tsx
  const [advancedOpen, setAdvancedOpen] = useState(false)
```
3. Reset it in the existing `useEffect(() => { if (open) {...} }, [open])` block: add `setAdvancedOpen(false)`.
4. In the returned JSX, put the ES button as the primary action ABOVE the form, and wrap the existing manual `<form>...</form>` in a Collapsible. Replace the `<form onSubmit={handleSubmit} ...>` block's surrounding so the structure becomes:

```tsx
        <div className="flex flex-col gap-4">
          <WhatsAppEmbeddedSignupButton onConnected={() => onOpenChange(false)} />

          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-between text-muted-foreground"
              >
                Advanced: use your own token
                <ChevronsUpDown className="size-4" />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              {/* existing manual <form onSubmit={handleSubmit} ...> ... </form> stays here verbatim */}
            </CollapsibleContent>
          </Collapsible>
        </div>
```

Keep the existing manual `<form>` (fields, validation, `connect.mutate`, footer) exactly as-is, just moved inside `CollapsibleContent`. Update the `DialogDescription` copy to: "Connect your WhatsApp Business account with Facebook — or expand Advanced to paste a token manually."

> shadcn note: `Collapsible` uses `@base-ui` under the hood in this repo (see `[[project_basecn_vs_radix_idioms]]`). `CollapsibleTrigger asChild` should work; if the installed wrapper does not support `asChild`, render the trigger without `asChild` and style it directly. Verify against `src/components/ui/collapsible.tsx`.

- [ ] **Step 3: Verify build**

Run: `cd socialmedia-frontend && npm run build`
Expected: tsc + vite build succeed.

- [ ] **Step 4: Manual smoke (no test runner on frontend)**

With `VITE_META_APP_ID` + `VITE_WHATSAPP_ES_CONFIG_ID` set in `.env`, run `npm run dev`, open the WhatsApp connect dialog: the primary "Connect with Facebook" button shows; "Advanced: use your own token" expands the manual form. (The actual FB dialog needs the Meta config_id + a test admin account — covered in the Meta console setup, not this build check.)

- [ ] **Step 5: Commit**

```bash
git add src/features/channels/components/whatsapp-embedded-signup-button.tsx src/features/channels/components/whatsapp-connect-dialog.tsx
git commit -m "feat(whatsapp): primary Embedded Signup CTA + manual form under Advanced"
```

---

## Self-review notes (for the executor)

- **Spec coverage:** Task 1 = Graph methods + version const + env; Task 2 = cross-workspace guard + deterministic routing (spec §"security fix"); Task 3 = endpoint + DTO + orchestration + error handling (expired code, subscribe-blocking, cross-workspace 409, idempotent register); Tasks 4–5 = FB SDK + hook + button + dialog restructure + env. Manual connect kept (Task 5 keeps the form). Out-of-scope items (Maestro `.some()` bug, template messages, token refresh) intentionally excluded.
- **Verify before "done":** backend `npm run build` + `npm run test -- whatsapp` + `npm run test -- channel.service`; frontend `npm run build`.
- **Do NOT** touch `facebook.service.ts` version, the webhook signature path, or remove the manual connect.
- **Meta console prerequisites** (user, not code): register app as Tech Provider, create a Facebook-Login-for-Business config → `config_id`, prefer a never-expiring token config, set `META_APP_ID` / `VITE_META_APP_ID` / `VITE_WHATSAPP_ES_CONFIG_ID`. Testable in dev mode by an app admin/developer.
```
