# WhatsApp Phase-2 — Media Messages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receive customer media (image/voice/audio/video/document) into the WhatsApp inbox and let the team reply with image + voice, reusing the existing inbox media infrastructure; plus auto-subscribe the WABA to the app on connect.

**Architecture:** Platform-specific glue over the existing media pipeline. Inbound: webhook parser captures media descriptors → ingest downloads from the Cloud API, rehosts to Cloudflare R2 (Slack model), and `upsertDm`s with `attachments`. Outbound: the DM adapter sends each R2 public URL to the Cloud API by `link` (no re-upload). Connect-time `subscribed_apps` POST closes the Phase-1 delivery gap.

**Tech Stack:** NestJS, Jest (`*.spec.ts` co-located), Drizzle, Cloudflare R2 (`CloudflareR2Service`), WhatsApp Cloud API v21.0. Frontend: Vite/React (one-line un-gate).

## Global Constraints

- Build gate (backend): `npm run build` in `socialmedia-workspace/` must pass.
- Test gate: `npm run test -- whatsapp` must pass (Jest, co-located `*.spec.ts`).
- Graph base is `WHATSAPP_GRAPH_BASE = 'https://graph.facebook.com/v21.0'` (exported from `whatsapp.service.ts`).
- Commits: surgical `git add <specific files>` only. NEVER `git add .`/`-A`. NEVER stage `.env`/`.env.backup`. End commit messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- R2 media kinds are `image | voice | video | file` (no `audio` kind — map `audio` → `voice`). R2 size caps: image 10 MB, voice 25 MB, video 100 MB, file 25 MB. R2 MIME allow-lists: image jpeg/png/gif/webp/heic; voice webm/ogg/mp4/mpeg/wav/aac/x-m4a; video mp4/webm/quicktime; file any.
- `DmAttachmentKind = 'image' | 'video' | 'audio' | 'voice' | 'file'` (from `inbox-adapter.interface.ts`).
- WhatsApp captions are valid only on `image`/`video`/`document` (NOT `audio`).

---

### Task 1: WhatsAppService — `downloadMedia` + `sendMedia`

**Files:**
- Modify: `src/channels/services/whatsapp.service.ts`
- Test: `src/channels/services/whatsapp.service.spec.ts`

**Interfaces:**
- Consumes: `WHATSAPP_GRAPH_BASE` (already in file).
- Produces:
  - `downloadMedia(accessToken: string, mediaId: string): Promise<{ buffer: Buffer; contentType: string }>`
  - `sendMedia(accessToken: string, phoneNumberId: string, toWaId: string, media: { type: 'image' | 'audio' | 'video' | 'document'; link: string; caption?: string; filename?: string }): Promise<{ messageId: string }>`

- [ ] **Step 1: Write the failing tests** (append to `whatsapp.service.spec.ts`)

```ts
describe('WhatsAppService.downloadMedia', () => {
  const svc = new WhatsAppService();
  afterEach(() => jest.restoreAllMocks());

  it('resolves the media url then downloads the binary with the bearer', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch' as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: 'https://lookaside.fbsbx.com/x', mime_type: 'image/jpeg' }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as any);

    const out = await svc.downloadMedia('tok', 'media123');

    expect(out.contentType).toBe('image/jpeg');
    expect(Buffer.isBuffer(out.buffer)).toBe(true);
    expect(out.buffer.length).toBe(3);
    expect(fetchMock.mock.calls[0][0]).toBe('https://graph.facebook.com/v21.0/media123');
    expect((fetchMock.mock.calls[0][1] as any).headers.Authorization).toBe('Bearer tok');
    expect(fetchMock.mock.calls[1][0]).toBe('https://lookaside.fbsbx.com/x');
    expect((fetchMock.mock.calls[1][1] as any).headers.Authorization).toBe('Bearer tok');
  });

  it('throws when the media lookup fails', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { message: 'media not found' } }),
    } as any);
    await expect(svc.downloadMedia('tok', 'bad')).rejects.toThrow('media not found');
  });
});

describe('WhatsAppService.sendMedia', () => {
  const svc = new WhatsAppService();
  afterEach(() => jest.restoreAllMocks());

  it('sends an image with a caption', async () => {
    const fetchMock = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.IMG' }] }),
    } as any);

    const res = await svc.sendMedia('tok', '1010', '15551234567', {
      type: 'image',
      link: 'https://r2.example/x.jpg',
      caption: 'here you go',
    });

    expect(res).toEqual({ messageId: 'wamid.IMG' });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as any).body)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'image',
      image: { link: 'https://r2.example/x.jpg', caption: 'here you go' },
    });
  });

  it('omits caption for audio', async () => {
    const fetchMock = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.AUD' }] }),
    } as any);

    await svc.sendMedia('tok', '1010', '15551234567', {
      type: 'audio',
      link: 'https://r2.example/v.ogg',
      caption: 'ignored',
    });

    expect(JSON.parse((fetchMock.mock.calls[0][1] as any).body)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'audio',
      audio: { link: 'https://r2.example/v.ogg' },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- whatsapp.service`
Expected: FAIL — `downloadMedia` / `sendMedia` are not functions.

- [ ] **Step 3: Implement the methods** (add inside the `WhatsAppService` class in `whatsapp.service.ts`, after `markRead`)

```ts
  /**
   * Download a media object by id. Two-step: resolve the (token-gated) URL,
   * then fetch the binary. Used by the inbox ingest to rehost to R2.
   */
  async downloadMedia(
    accessToken: string,
    mediaId: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const metaRes = await fetch(`${WHATSAPP_GRAPH_BASE}/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const meta = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok || !meta?.url) {
      const msg =
        meta?.error?.message || `WhatsApp media lookup failed (${metaRes.status})`;
      throw new Error(msg);
    }
    const binRes = await fetch(meta.url as string, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!binRes.ok) {
      throw new Error(`WhatsApp media download failed (${binRes.status})`);
    }
    const buffer = Buffer.from(await binRes.arrayBuffer());
    const contentType =
      (meta.mime_type as string) ||
      binRes.headers.get('content-type') ||
      'application/octet-stream';
    return { buffer, contentType };
  }

  /**
   * Send a media message by public link (R2 URL). Captions are valid only on
   * image/video/document; `filename` only on document. 24h window applies.
   */
  async sendMedia(
    accessToken: string,
    phoneNumberId: string,
    toWaId: string,
    media: {
      type: 'image' | 'audio' | 'video' | 'document';
      link: string;
      caption?: string;
      filename?: string;
    },
  ): Promise<{ messageId: string }> {
    const mediaObj: Record<string, unknown> = { link: media.link };
    if (media.caption && media.type !== 'audio') mediaObj.caption = media.caption;
    if (media.filename && media.type === 'document') mediaObj.filename = media.filename;

    const res = await fetch(`${WHATSAPP_GRAPH_BASE}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toWaId,
        type: media.type,
        [media.type]: mediaObj,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        data?.error?.message || `WhatsApp media send failed (${res.status})`;
      throw new Error(msg);
    }
    return { messageId: data?.messages?.[0]?.id ?? '' };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- whatsapp.service`
Expected: PASS (all sendText + downloadMedia + sendMedia tests).

- [ ] **Step 5: Commit**

```bash
git add src/channels/services/whatsapp.service.ts src/channels/services/whatsapp.service.spec.ts
git commit -m "feat(whatsapp): downloadMedia + sendMedia (Cloud API media primitives)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Webhook parser — capture media + location/contacts

**Files:**
- Modify: `src/channels/services/whatsapp-webhook.util.ts`
- Test: `src/channels/services/whatsapp-webhook.util.spec.ts`

**Interfaces:**
- Produces (extends `ParsedWhatsAppMessage`):
  - `media?: { mediaId: string; kind: 'image' | 'video' | 'audio' | 'voice' | 'file'; mimeType?: string; caption?: string; filename?: string }`
  - `note?: string`
  - existing fields (`phoneNumberId`, `fromWaId`, `messageId`, `text`, `timestamp`, `authorName`, `isText`, `referral`) unchanged.

- [ ] **Step 1: Write the failing tests** (append cases to `whatsapp-webhook.util.spec.ts`)

```ts
describe('parseWhatsAppMessages — media', () => {
  const wrap = (msg: any) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '1010' },
      contacts: [{ profile: { name: 'Asad' }, wa_id: '15551234567' }],
      messages: [{ from: '15551234567', id: 'wamid.M', timestamp: '1719400000', ...msg }],
    } }] }],
  });

  it('captures an image with caption', () => {
    const [m] = parseWhatsAppMessages(wrap({ type: 'image', image: { id: 'mid', mime_type: 'image/jpeg', caption: 'look' } }));
    expect(m.isText).toBe(false);
    expect(m.media).toEqual({ mediaId: 'mid', kind: 'image', mimeType: 'image/jpeg', caption: 'look', filename: undefined });
    expect(m.text).toBe('look');
  });

  it('maps a voice note (audio.voice=true) to kind voice', () => {
    const [m] = parseWhatsAppMessages(wrap({ type: 'audio', audio: { id: 'a1', mime_type: 'audio/ogg', voice: true } }));
    expect(m.media?.kind).toBe('voice');
  });

  it('maps non-voice audio to kind audio', () => {
    const [m] = parseWhatsAppMessages(wrap({ type: 'audio', audio: { id: 'a2', mime_type: 'audio/mpeg' } }));
    expect(m.media?.kind).toBe('audio');
  });

  it('maps a document to kind file with filename', () => {
    const [m] = parseWhatsAppMessages(wrap({ type: 'document', document: { id: 'd1', mime_type: 'application/pdf', filename: 'invoice.pdf', caption: 'bill' } }));
    expect(m.media).toEqual({ mediaId: 'd1', kind: 'file', mimeType: 'application/pdf', caption: 'bill', filename: 'invoice.pdf' });
  });

  it('maps a sticker to kind image', () => {
    const [m] = parseWhatsAppMessages(wrap({ type: 'sticker', sticker: { id: 's1', mime_type: 'image/webp' } }));
    expect(m.media?.kind).toBe('image');
  });

  it('captures a video', () => {
    const [m] = parseWhatsAppMessages(wrap({ type: 'video', video: { id: 'v1', mime_type: 'video/mp4' } }));
    expect(m.media?.kind).toBe('video');
  });

  it('emits a note for location and contacts', () => {
    const [loc] = parseWhatsAppMessages(wrap({ type: 'location', location: { latitude: 1, longitude: 2 } }));
    expect(loc.note).toBe('📍 Location');
    const [con] = parseWhatsAppMessages(wrap({ type: 'contacts', contacts: [{ name: { formatted_name: 'X' } }] }));
    expect(con.note).toBe('👤 Contact');
  });

  it('skips unsupported types (e.g. reaction)', () => {
    expect(parseWhatsAppMessages(wrap({ type: 'reaction', reaction: { emoji: '👍' } }))).toEqual([]);
  });
});
```

NOTE: the existing test `'marks non-text (e.g. image) as isText=false'` still passes (image is pushed with `isText:false`, `text:''`); leave it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- whatsapp-webhook.util`
Expected: FAIL — `m.media` undefined / `note` undefined.

- [ ] **Step 3: Implement** — replace the export interface and the message loop in `whatsapp-webhook.util.ts`

Replace the `ParsedWhatsAppMessage` interface (lines 1-10) with:

```ts
export interface ParsedWhatsAppMedia {
  mediaId: string;
  kind: 'image' | 'video' | 'audio' | 'voice' | 'file';
  mimeType?: string;
  caption?: string;
  filename?: string;
}

export interface ParsedWhatsAppMessage {
  phoneNumberId: string;
  fromWaId: string;
  messageId: string;
  text: string;
  timestamp: Date;
  authorName?: string;
  isText: boolean;
  /** Present for image/video/audio/voice/document/sticker messages. */
  media?: ParsedWhatsAppMedia;
  /** Placeholder text for non-media, non-text messages (location/contacts). */
  note?: string;
  referral?: Record<string, any>;
}
```

Replace the inner `for (const msg of messages) { ... }` loop body with:

```ts
      for (const msg of messages) {
        const base = {
          phoneNumberId: String(phoneNumberId),
          fromWaId: String(msg?.from ?? ''),
          messageId: String(msg?.id ?? ''),
          timestamp: msg?.timestamp
            ? new Date(Number(msg.timestamp) * 1000)
            : new Date(),
          authorName: nameByWaId.get(String(msg?.from ?? '')),
          referral: msg?.referral,
        };
        const type = msg?.type as string | undefined;

        if (type === 'text' && typeof msg?.text?.body === 'string') {
          out.push({ ...base, text: String(msg.text.body), isText: true });
        } else if (
          type === 'image' ||
          type === 'video' ||
          type === 'audio' ||
          type === 'document' ||
          type === 'sticker'
        ) {
          const node = msg[type] ?? {};
          const kind: ParsedWhatsAppMedia['kind'] =
            type === 'image' || type === 'sticker'
              ? 'image'
              : type === 'video'
                ? 'video'
                : type === 'document'
                  ? 'file'
                  : node?.voice === true
                    ? 'voice'
                    : 'audio';
          const caption =
            typeof node?.caption === 'string' ? node.caption : undefined;
          out.push({
            ...base,
            text: caption ?? '',
            isText: false,
            media: {
              mediaId: String(node?.id ?? ''),
              kind,
              mimeType: node?.mime_type ? String(node.mime_type) : undefined,
              caption,
              filename:
                type === 'document' && node?.filename
                  ? String(node.filename)
                  : undefined,
            },
          });
        } else if (type === 'location') {
          out.push({ ...base, text: '', isText: false, note: '📍 Location' });
        } else if (type === 'contacts') {
          out.push({ ...base, text: '', isText: false, note: '👤 Contact' });
        }
        // else: unsupported (reaction/button/system/...) — skip
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- whatsapp-webhook.util`
Expected: PASS (existing text/image/status tests + new media tests).

- [ ] **Step 5: Commit**

```bash
git add src/channels/services/whatsapp-webhook.util.ts src/channels/services/whatsapp-webhook.util.spec.ts
git commit -m "feat(whatsapp): parse inbound media + location/contacts in webhook util

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Ingest — download → rehost to R2 → upsertDm with attachments

**Files:**
- Modify: `src/inbox/services/whatsapp-ingest.service.ts`
- Test: `src/inbox/services/whatsapp-ingest.service.spec.ts`

**Interfaces:**
- Consumes: `parseWhatsAppMessages` (Task 2); `WhatsAppService.downloadMedia` (Task 1); `ChannelService.getAccessToken(channelId: number, workspaceId: string): Promise<string>`; `CloudflareR2Service.uploadBuffer({ kind, workspaceId, buffer, contentType, filename }): Promise<{ key: string; publicUrl: string }>`; `InboxService.findChannelByPlatformAccount`, `InboxService.upsertDm`.
- Produces: unchanged public method `ingest(payload: any): Promise<void>`.

NOTE: DI is already satisfied by `InboxModule` — it imports `ChannelsModule` (exports `ChannelService`) and `MediaModule` (exports `CloudflareR2Service`), and provides `WhatsAppService`. No module edit needed.

- [ ] **Step 1: Rewrite the tests** — replace the body of `whatsapp-ingest.service.spec.ts`

```ts
import { WhatsAppIngestService } from './whatsapp-ingest.service';

const channel = { id: 7, workspaceId: 'ws' };

function makeDeps(over: Partial<Record<string, any>> = {}) {
  const inbox = {
    findChannelByPlatformAccount: jest.fn().mockResolvedValue(channel),
    upsertDm: jest.fn().mockResolvedValue({ id: 'row1' }),
  };
  const channelService = { getAccessToken: jest.fn().mockResolvedValue('tok') };
  const whatsapp = {
    downloadMedia: jest
      .fn()
      .mockResolvedValue({ buffer: Buffer.from([1]), contentType: 'image/jpeg' }),
  };
  const r2 = {
    uploadBuffer: jest
      .fn()
      .mockResolvedValue({ key: 'k', publicUrl: 'https://r2/k.jpg' }),
  };
  return { inbox, channelService, whatsapp, r2, ...over };
}

const wrap = (msg: any) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: '1010' },
    contacts: [{ profile: { name: 'Asad' }, wa_id: '15551234567' }],
    messages: [{ from: '15551234567', id: 'wamid.M', timestamp: '1719400000', ...msg }],
  } }] }],
});

describe('WhatsAppIngestService.ingest', () => {
  it('upserts a text DM with E.164 handle', async () => {
    const d = makeDeps();
    await new WhatsAppIngestService(d.inbox as any, d.channelService as any, d.whatsapp as any, d.r2 as any)
      .ingest(wrap({ type: 'text', text: { body: 'hi' } }));
    expect(d.inbox.upsertDm).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 7, workspaceId: 'ws', platform: 'whatsapp',
        conversationId: '1010:15551234567', text: 'hi', fromMe: false,
        authorHandle: '+15551234567', authorDisplayName: 'Asad',
      }),
    );
  });

  it('downloads media, rehosts to R2, and upserts attachments', async () => {
    const d = makeDeps();
    await new WhatsAppIngestService(d.inbox as any, d.channelService as any, d.whatsapp as any, d.r2 as any)
      .ingest(wrap({ type: 'image', image: { id: 'mid', mime_type: 'image/jpeg', caption: 'look' } }));
    expect(d.whatsapp.downloadMedia).toHaveBeenCalledWith('tok', 'mid');
    expect(d.r2.uploadBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', workspaceId: 'ws', contentType: 'image/jpeg' }),
    );
    expect(d.inbox.upsertDm).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'look',
        attachments: [{ kind: 'image', url: 'https://r2/k.jpg', contentType: 'image/jpeg' }],
      }),
    );
  });

  it('maps a voice note to R2 kind voice', async () => {
    const d = makeDeps();
    d.whatsapp.downloadMedia.mockResolvedValue({ buffer: Buffer.from([1]), contentType: 'audio/ogg' });
    await new WhatsAppIngestService(d.inbox as any, d.channelService as any, d.whatsapp as any, d.r2 as any)
      .ingest(wrap({ type: 'audio', audio: { id: 'a1', mime_type: 'audio/ogg', voice: true } }));
    expect(d.r2.uploadBuffer).toHaveBeenCalledWith(expect.objectContaining({ kind: 'voice' }));
    expect(d.inbox.upsertDm).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [expect.objectContaining({ kind: 'voice' })] }),
    );
  });

  it('falls back to a text note when media rehost fails', async () => {
    const d = makeDeps();
    d.whatsapp.downloadMedia.mockRejectedValue(new Error('boom'));
    await new WhatsAppIngestService(d.inbox as any, d.channelService as any, d.whatsapp as any, d.r2 as any)
      .ingest(wrap({ type: 'image', image: { id: 'mid', mime_type: 'image/jpeg' } }));
    expect(d.inbox.upsertDm).toHaveBeenCalledWith(
      expect.objectContaining({ text: '[media unavailable]' }),
    );
  });

  it('stores a placeholder note for location', async () => {
    const d = makeDeps();
    await new WhatsAppIngestService(d.inbox as any, d.channelService as any, d.whatsapp as any, d.r2 as any)
      .ingest(wrap({ type: 'location', location: { latitude: 1, longitude: 2 } }));
    expect(d.inbox.upsertDm).toHaveBeenCalledWith(expect.objectContaining({ text: '📍 Location' }));
  });

  it('skips when no channel matches', async () => {
    const d = makeDeps({ inbox: { findChannelByPlatformAccount: jest.fn().mockResolvedValue(undefined), upsertDm: jest.fn() } });
    await new WhatsAppIngestService(d.inbox as any, d.channelService as any, d.whatsapp as any, d.r2 as any)
      .ingest(wrap({ type: 'text', text: { body: 'hi' } }));
    expect(d.inbox.upsertDm).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- whatsapp-ingest`
Expected: FAIL — constructor arity / media branch not implemented.

- [ ] **Step 3: Implement** — replace the whole `src/inbox/services/whatsapp-ingest.service.ts`

```ts
import { Injectable, Logger } from '@nestjs/common';
import { InboxService } from '../inbox.service';
import { ChannelService } from '../../channels/services/channel.service';
import { WhatsAppService } from '../../channels/services/whatsapp.service';
import { CloudflareR2Service } from '../../media/cloudflare-r2.service';
import { parseWhatsAppMessages } from '../../channels/services/whatsapp-webhook.util';

@Injectable()
export class WhatsAppIngestService {
  private readonly logger = new Logger(WhatsAppIngestService.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly channelService: ChannelService,
    private readonly whatsapp: WhatsAppService,
    private readonly r2: CloudflareR2Service,
  ) {}

  async ingest(payload: any): Promise<void> {
    for (const m of parseWhatsAppMessages(payload)) {
      const channel = await this.inbox.findChannelByPlatformAccount(
        'whatsapp',
        m.phoneNumberId,
      );
      if (!channel) {
        this.logger.warn(
          `No whatsapp channel for phone_number_id=${m.phoneNumberId}; dropping message ${m.messageId}`,
        );
        continue;
      }

      const base = {
        workspaceId: channel.workspaceId,
        channelId: channel.id,
        platform: 'whatsapp' as const,
        conversationId: `${m.phoneNumberId}:${m.fromWaId}`,
        platformItemId: m.messageId,
        authorPlatformId: m.fromWaId,
        authorHandle: m.fromWaId ? `+${m.fromWaId}` : undefined,
        authorDisplayName: m.authorName ?? `+${m.fromWaId}`,
        fromMe: false,
        platformCreatedAt: m.timestamp,
        metadata: m.referral ? { referral: m.referral } : undefined,
      };

      if (m.media) {
        try {
          const accessToken = await this.channelService.getAccessToken(
            channel.id,
            channel.workspaceId,
          );
          const { buffer, contentType } = await this.whatsapp.downloadMedia(
            accessToken,
            m.media.mediaId,
          );
          // No 'audio' R2 kind — audio shares the 'voice' prefix/limits.
          const r2Kind =
            m.media.kind === 'audio' ? 'voice' : m.media.kind;
          const { publicUrl } = await this.r2.uploadBuffer({
            kind: r2Kind,
            workspaceId: channel.workspaceId,
            buffer,
            contentType: m.media.mimeType ?? contentType,
            filename: m.media.filename ?? `whatsapp-${m.media.mediaId}`,
          });
          await this.inbox.upsertDm({
            ...base,
            text: m.media.caption ?? '',
            attachments: [
              {
                kind: m.media.kind,
                url: publicUrl,
                contentType: m.media.mimeType ?? contentType,
              },
            ],
          });
        } catch (err) {
          this.logger.warn(
            `WhatsApp media rehost failed for ${m.messageId}: ${(err as Error).message}`,
          );
          await this.inbox.upsertDm({
            ...base,
            text: m.media.caption || '[media unavailable]',
          });
        }
      } else if (m.note) {
        await this.inbox.upsertDm({ ...base, text: m.note });
      } else if (m.isText) {
        await this.inbox.upsertDm({ ...base, text: m.text });
      }
    }
  }
}
```

- [ ] **Step 4: Run tests + build**

Run: `npm run test -- whatsapp-ingest`  → Expected: PASS
Run: `npm run build` → Expected: PASS (DI resolves; `r2Kind` typed as `R2MediaKind`).

- [ ] **Step 5: Commit**

```bash
git add src/inbox/services/whatsapp-ingest.service.ts src/inbox/services/whatsapp-ingest.service.spec.ts
git commit -m "feat(whatsapp): ingest inbound media — download, rehost to R2, upsert attachments

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: DM adapter — `sendDmWithAttachments`

**Files:**
- Modify: `src/inbox/adapters/whatsapp-dm.adapter.ts`
- Test: `src/inbox/adapters/whatsapp-dm.adapter.spec.ts`

**Interfaces:**
- Consumes: `WhatsAppService.sendMedia` + `WhatsAppService.sendText` (Task 1 + existing); `DmAttachmentInput` from `inbox-adapter.interface.ts`.
- Produces: `WhatsAppDmAdapter.sendDmWithAttachments(channel, conversationId, text, attachments): Promise<CreatedDm>`.

- [ ] **Step 1: Write the failing tests** (append to `whatsapp-dm.adapter.spec.ts`)

```ts
describe('WhatsAppDmAdapter.sendDmWithAttachments', () => {
  it('sends an image carrying the text as caption', async () => {
    const wa = { sendMedia: jest.fn().mockResolvedValue({ messageId: 'wamid.IMG' }), sendText: jest.fn() } as any;
    const adapter = new WhatsAppDmAdapter(wa);
    const res = await adapter.sendDmWithAttachments(channel(), '1010:15551234567', 'caption!', [
      { kind: 'image', url: 'https://r2/x.jpg', contentType: 'image/jpeg' },
    ]);
    expect(wa.sendMedia).toHaveBeenCalledWith('tok', '1010', '15551234567', {
      type: 'image', link: 'https://r2/x.jpg', caption: 'caption!', filename: undefined,
    });
    expect(wa.sendText).not.toHaveBeenCalled();
    expect(res.platformItemId).toBe('wamid.IMG');
  });

  it('sends a voice note then the text as a separate message (audio has no caption)', async () => {
    const wa = {
      sendMedia: jest.fn().mockResolvedValue({ messageId: 'wamid.AUD' }),
      sendText: jest.fn().mockResolvedValue({ messageId: 'wamid.TXT' }),
    } as any;
    const adapter = new WhatsAppDmAdapter(wa);
    const res = await adapter.sendDmWithAttachments(channel(), '1010:15551234567', 'hello', [
      { kind: 'voice', url: 'https://r2/v.ogg', contentType: 'audio/ogg' },
    ]);
    expect(wa.sendMedia).toHaveBeenCalledWith('tok', '1010', '15551234567', {
      type: 'audio', link: 'https://r2/v.ogg', caption: undefined, filename: undefined,
    });
    expect(wa.sendText).toHaveBeenCalledWith('tok', '1010', '15551234567', 'hello');
    expect(res.platformItemId).toBe('wamid.TXT');
  });

  it('falls back to sendDm when there are no attachments', async () => {
    const wa = { sendText: jest.fn().mockResolvedValue({ messageId: 'wamid.X' }), sendMedia: jest.fn() } as any;
    const adapter = new WhatsAppDmAdapter(wa);
    await adapter.sendDmWithAttachments(channel(), '1010:999', 'hi', []);
    expect(wa.sendText).toHaveBeenCalled();
    expect(wa.sendMedia).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- whatsapp-dm.adapter`
Expected: FAIL — `sendDmWithAttachments` not a function.

- [ ] **Step 3: Implement** — add the import + method to `whatsapp-dm.adapter.ts`

Add `DmAttachmentInput` to the type import from `./inbox-adapter.interface`:

```ts
import type {
  PlatformDmAdapter,
  ResolvedChannel,
  DmConversationSummary,
  FetchedDm,
  CreatedDm,
  DmAttachmentInput,
} from './inbox-adapter.interface';
```

Add this method inside the class (after `sendDm`):

```ts
  /**
   * Send media replies by public R2 link. Captions are valid only on
   * image/video/document — the reply text rides on the first such attachment;
   * if none qualifies (e.g. a lone voice note) the text is sent separately.
   */
  async sendDmWithAttachments(
    channel: ResolvedChannel,
    conversationId: string,
    text: string,
    attachments: DmAttachmentInput[],
  ): Promise<CreatedDm> {
    if (attachments.length === 0) {
      return this.sendDm(channel, conversationId, text);
    }
    const phoneNumberId = String(
      channel.metadata?.phoneNumberId ?? channel.platformAccountId,
    );
    const toWaId = conversationId.slice(conversationId.lastIndexOf(':') + 1);

    const toWaType = (
      k: DmAttachmentInput['kind'],
    ): 'image' | 'audio' | 'video' | 'document' =>
      k === 'image'
        ? 'image'
        : k === 'video'
          ? 'video'
          : k === 'voice' || k === 'audio'
            ? 'audio'
            : 'document';

    const captionIdx = attachments.findIndex(
      (a) => a.kind === 'image' || a.kind === 'video' || a.kind === 'file',
    );

    let lastMessageId = '';
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const filename = decodeURIComponent(
        att.url.split('/').pop() ?? 'attachment',
      );
      const { messageId } = await this.whatsapp.sendMedia(
        channel.accessToken,
        phoneNumberId,
        toWaId,
        {
          type: toWaType(att.kind),
          link: att.url,
          caption: i === captionIdx && text ? text : undefined,
          filename: att.kind === 'file' ? filename : undefined,
        },
      );
      lastMessageId = messageId;
    }

    if (text && captionIdx === -1) {
      const { messageId } = await this.whatsapp.sendText(
        channel.accessToken,
        phoneNumberId,
        toWaId,
        text,
      );
      lastMessageId = messageId;
    }

    return {
      conversationId,
      platformItemId: lastMessageId,
      text,
      platformCreatedAt: new Date(),
    };
  }
```

- [ ] **Step 4: Run tests + build**

Run: `npm run test -- whatsapp-dm.adapter` → Expected: PASS
Run: `npm run build` → Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/inbox/adapters/whatsapp-dm.adapter.ts src/inbox/adapters/whatsapp-dm.adapter.spec.ts
git commit -m "feat(whatsapp): sendDmWithAttachments — media replies via send-by-link

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Connect gap — auto-subscribe the WABA on connect

**Files:**
- Modify: `src/channels/services/whatsapp.service.ts`
- Test: `src/channels/services/whatsapp.service.spec.ts`
- Modify: `src/channels/channels.controller.ts` (inject `WhatsAppService`, call after `createChannel` in `connectWhatsApp`)
- Modify: `src/channels/channels.module.ts` (add `WhatsAppService` to `providers`)

**Interfaces:**
- Produces: `WhatsAppService.subscribeWaba(accessToken: string, wabaId: string): Promise<void>` (throws on failure).

- [ ] **Step 1: Write the failing test** (append to `whatsapp.service.spec.ts`)

```ts
describe('WhatsAppService.subscribeWaba', () => {
  const svc = new WhatsAppService();
  afterEach(() => jest.restoreAllMocks());

  it('POSTs to the WABA subscribed_apps edge', async () => {
    const fetchMock = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as any);
    await svc.subscribeWaba('tok', '12345');
    expect(fetchMock.mock.calls[0][0]).toBe('https://graph.facebook.com/v21.0/12345/subscribed_apps');
    expect((fetchMock.mock.calls[0][1] as any).method).toBe('POST');
    expect((fetchMock.mock.calls[0][1] as any).headers.Authorization).toBe('Bearer tok');
  });

  it('throws on API failure', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: false, status: 400, json: async () => ({ error: { message: 'no perms' } }),
    } as any);
    await expect(svc.subscribeWaba('tok', '12345')).rejects.toThrow('no perms');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- whatsapp.service`
Expected: FAIL — `subscribeWaba` not a function.

- [ ] **Step 3a: Implement `subscribeWaba`** (add to `WhatsAppService` in `whatsapp.service.ts`)

```ts
  /**
   * Subscribe this app to the WABA so inbound message webhooks are delivered.
   * Manual webhook config alone does NOT route a specific WABA's events — the
   * WABA must list the app under subscribed_apps. Throws so the caller can log.
   */
  async subscribeWaba(accessToken: string, wabaId: string): Promise<void> {
    const res = await fetch(
      `${WHATSAPP_GRAPH_BASE}/${wabaId}/subscribed_apps`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.success === false) {
      const msg =
        data?.error?.message || `WABA subscribe failed (${res.status})`;
      throw new Error(msg);
    }
  }
```

- [ ] **Step 3b: Provide `WhatsAppService` in `channels.module.ts`**

In `src/channels/channels.module.ts`: add the import and the provider entry.

```ts
import { WhatsAppService } from './services/whatsapp.service';
```
Add `WhatsAppService,` to the `providers` array.

- [ ] **Step 3c: Inject + call in `channels.controller.ts`**

Add to the import block (it already imports `ConnectWhatsAppDto`):
```ts
import { WhatsAppService } from './services/whatsapp.service';
```
Add a constructor param (next to the other services):
```ts
    private readonly whatsappService: WhatsAppService,
```
In `connectWhatsApp`, change the final `return this.channelService.createChannel(...)` to capture the channel and subscribe before returning:

```ts
    const channel = await this.channelService.createChannel(
      workspaceId,
      user.userId,
      {
        platform: 'whatsapp',
        accountType: 'business_account',
        platformAccountId: dto.phoneNumberId,
        accountName,
        accessToken: dto.accessToken,
        metadata: {
          wabaId: dto.wabaId,
          displayPhoneNumber: resolvedDisplayPhone,
        },
      },
    );

    // Subscribe this app to the WABA so inbound message webhooks are delivered.
    // Best-effort: never block the connect on a subscribe failure.
    try {
      await this.whatsappService.subscribeWaba(dto.accessToken, dto.wabaId);
    } catch (err) {
      this.logger.warn(
        `WABA subscribe failed for waba=${dto.wabaId}: ${(err as Error).message}`,
      );
    }

    return channel;
```

- [ ] **Step 4: Run test + build**

Run: `npm run test -- whatsapp.service` → Expected: PASS
Run: `npm run build` → Expected: PASS (DI resolves `WhatsAppService` in `ChannelsController`).

- [ ] **Step 5: Commit**

```bash
git add src/channels/services/whatsapp.service.ts src/channels/services/whatsapp.service.spec.ts src/channels/channels.controller.ts src/channels/channels.module.ts
git commit -m "feat(whatsapp): auto-subscribe WABA to the app on connect

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Frontend — enable image + voice composer for WhatsApp

**Files:**
- Modify: `src/features/inbox/components/dm-thread.tsx` (in `socialmedia-frontend`)

NOTE: this task runs in the **frontend** repo `d:\My Documents\MyProjects\FullStackProjects\socialmedia-frontend`. No new tests (no FE test framework); the gate is `npm run build`.

- [ ] **Step 1: Un-gate WhatsApp attachments**

In `src/features/inbox/components/dm-thread.tsx`, change:

```tsx
  // Attachment-supported platforms. Bluesky chat doesn't support attachments;
  // WhatsApp Phase-1 sends text only (media is Phase 2).
  const platformSupportsAttachments =
    conversation.platform !== 'bluesky' &&
    conversation.platform !== 'whatsapp'
```

to:

```tsx
  // Attachment-supported platforms. Bluesky chat doesn't support attachments.
  // WhatsApp supports image + voice replies (Phase 2).
  const platformSupportsAttachments = conversation.platform !== 'bluesky'
```

- [ ] **Step 2: Build to verify**

Run: `npm run build` (in `socialmedia-frontend/`)
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/features/inbox/components/dm-thread.tsx
git commit -m "feat(whatsapp): enable image + voice composer in the inbox (Phase 2 media)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Manual verification (after all tasks, on the Meta test number)

1. From a phone, send to the test number: an **image with caption**, a **voice note**, a **video**, a **document** → each appears in the inbox, correctly rendered (image inline, voice in the waveform player, video player, file link); the image caption shows as text.
2. Send a **location** → a `📍 Location` note appears.
3. Reply with an **image + caption** and a **voice note** → both arrive on the phone.
4. Connect a **fresh** number via the UI (without manually calling `subscribed_apps`) → inbound messages arrive (verifies the gap fix).
5. Conversation-list rows show the correct media icon (photo/voice/video/file) for the last message.
