import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../drizzle/db';
import {
  maestroChannelLinks,
  type MaestroBridgeChannel,
  type MaestroChannelLink,
} from '../../../drizzle/schema/maestro-links.schema';
import { maestroBridgeThreads } from '../../../drizzle/schema/maestro-bridge-threads.schema';

/** Connect links are short-lived so a leaked URL can't be reused later. */
const TOKEN_TTL_MS = 10 * 60 * 1000;

/** Bytes of the truncated HMAC kept in the token (80-bit tag — ample for a
 *  10-minute, single-purpose link). */
const SIG_BYTES = 10;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** UUID (with dashes) → 16 raw bytes. Throws if the id isn't a UUID. */
function uuidToBytes(uuid: string): Buffer {
  if (!UUID_RE.test(uuid)) {
    throw new Error('connect token: id must be a UUID');
  }
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

/** 16 raw bytes → canonical dashed UUID string. */
function bytesToUuid(buf: Buffer): string {
  const h = buf.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(
    16,
    20,
  )}-${h.slice(20)}`;
}

/** A choice prompt awaiting a button tap (stored on the link's metadata). */
export interface PendingChoice {
  kind: 'question' | 'workspace';
  /** Values to act on: option text (question) or workspace id (switch). */
  items: string[];
  /** Button captions shown to the user. */
  labels: string[];
}

/**
 * Issues/verifies the signed deep-link tokens used to bind an external identity
 * (Telegram user, …) to a Schedura account, and owns CRUD over
 * `maestro_channel_links`. The token is stateless (no DB round-trip to verify) —
 * tamper-proof via a truncated HMAC, time-boxed via an embedded expiry.
 *
 * Layout (binary, then base64url): userId(16) ++ workspaceId(16) ++ exp:u32(4)
 * ++ HMAC-SHA256(secret, the 36-byte head)[0..10) = 46 bytes → 62 base64url
 * chars. This is deliberately compact: Telegram's `?start=` deep-link parameter
 * is capped at 64 chars and allows only [A-Za-z0-9_-] (no `.`), which the old
 * JSON-payload token (≈175 chars, with a `.`) silently violated — Telegram
 * dropped it, so the bot opened with no token and connect never happened.
 */
@Injectable()
export class BridgeLinkService {
  constructor(private readonly config: ConfigService) {}

  private secret(): string {
    return (
      this.config.get<string>('MAESTRO_LINK_SECRET') ||
      this.config.get<string>('MAESTRO_TELEGRAM_WEBHOOK_SECRET') ||
      'dev-insecure-link-secret'
    );
  }

  /** HMAC over the token head, truncated to SIG_BYTES. */
  private tag(head: Buffer): Buffer {
    return createHmac('sha256', this.secret())
      .update(head)
      .digest()
      .subarray(0, SIG_BYTES);
  }

  issueLinkToken(userId: string, workspaceId: string): string {
    const head = Buffer.alloc(36);
    uuidToBytes(userId).copy(head, 0);
    uuidToBytes(workspaceId).copy(head, 16);
    head.writeUInt32BE(Math.floor((Date.now() + TOKEN_TTL_MS) / 1000), 32);
    return Buffer.concat([head, this.tag(head)]).toString('base64url');
  }

  verifyLinkToken(
    token: string,
  ): { userId: string; workspaceId: string } | null {
    try {
      const buf = Buffer.from(token, 'base64url');
      if (buf.length !== 36 + SIG_BYTES) return null;
      const head = buf.subarray(0, 36);
      const sig = buf.subarray(36);
      const expected = this.tag(head);
      if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
        return null;
      }
      const exp = head.readUInt32BE(32);
      if (Math.floor(Date.now() / 1000) > exp) return null;
      return {
        userId: bytesToUuid(head.subarray(0, 16)),
        workspaceId: bytesToUuid(head.subarray(16, 32)),
      };
    } catch {
      return null;
    }
  }

  async upsertLink(p: {
    userId: string;
    channel: MaestroBridgeChannel;
    externalId: string;
    displayName?: string;
    defaultWorkspaceId: string;
    metadata?: Record<string, unknown>;
  }): Promise<MaestroChannelLink> {
    const [row] = await db
      .insert(maestroChannelLinks)
      .values({
        userId: p.userId,
        channel: p.channel,
        externalId: p.externalId,
        displayName: p.displayName ?? null,
        defaultWorkspaceId: p.defaultWorkspaceId,
        status: 'active',
        metadata: p.metadata ?? {},
      })
      .onConflictDoUpdate({
        target: [maestroChannelLinks.channel, maestroChannelLinks.externalId],
        set: {
          userId: p.userId,
          displayName: p.displayName ?? null,
          defaultWorkspaceId: p.defaultWorkspaceId,
          status: 'active',
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async findLink(
    channel: MaestroBridgeChannel,
    externalId: string,
  ): Promise<MaestroChannelLink | null> {
    const [row] = await db
      .select()
      .from(maestroChannelLinks)
      .where(
        and(
          eq(maestroChannelLinks.channel, channel),
          eq(maestroChannelLinks.externalId, externalId),
          eq(maestroChannelLinks.status, 'active'),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async setDefaultWorkspace(linkId: string, workspaceId: string): Promise<void> {
    await db
      .update(maestroChannelLinks)
      .set({ defaultWorkspaceId: workspaceId, updatedAt: new Date() })
      .where(eq(maestroChannelLinks.id, linkId));
  }

  async setConversation(
    linkId: string,
    conversationId: string | null,
  ): Promise<void> {
    await db
      .update(maestroChannelLinks)
      .set({ conversationId, updatedAt: new Date() })
      .where(eq(maestroChannelLinks.id, linkId));
  }

  /**
   * Stash a pending choice prompt (the options/workspaces last shown as inline
   * buttons) on the link so a `callback_query` tap can be resolved back to the
   * chosen value. `labels` are the button captions, `items` the values to act on
   * (option text for questions, workspace id for switch). Pass null to clear.
   */
  async setPending(
    linkId: string,
    pending: PendingChoice | null,
  ): Promise<void> {
    await db
      .update(maestroChannelLinks)
      .set({
        metadata: pending ? { pending } : {},
        updatedAt: new Date(),
      })
      .where(eq(maestroChannelLinks.id, linkId));
  }

  async revoke(linkId: string): Promise<void> {
    await db
      .update(maestroChannelLinks)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(eq(maestroChannelLinks.id, linkId));
  }

  /**
   * The shared Maestro thread for a (user, workspace) with its last-activity time
   * — all of the user's linked numbers/channels in that workspace use this one
   * conversation, so Maestro keeps one continuous memory. `updatedAt` drives the
   * inactivity auto-reset. Returns null if none exists yet.
   */
  async getThread(
    userId: string,
    workspaceId: string,
  ): Promise<{ conversationId: string; updatedAt: Date } | null> {
    const [row] = await db
      .select({
        conversationId: maestroBridgeThreads.conversationId,
        updatedAt: maestroBridgeThreads.updatedAt,
      })
      .from(maestroBridgeThreads)
      .where(
        and(
          eq(maestroBridgeThreads.userId, userId),
          eq(maestroBridgeThreads.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Bump the thread's last-activity time (keeps the current session alive). */
  async touchThread(userId: string, workspaceId: string): Promise<void> {
    await db
      .update(maestroBridgeThreads)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(maestroBridgeThreads.userId, userId),
          eq(maestroBridgeThreads.workspaceId, workspaceId),
        ),
      );
  }

  /** Drop the thread mapping so the next message starts a fresh session. */
  async resetThread(userId: string, workspaceId: string): Promise<void> {
    await db
      .delete(maestroBridgeThreads)
      .where(
        and(
          eq(maestroBridgeThreads.userId, userId),
          eq(maestroBridgeThreads.workspaceId, workspaceId),
        ),
      );
  }

  /** Upsert the (user, workspace) → conversation mapping. */
  async setThreadConversation(
    userId: string,
    workspaceId: string,
    conversationId: string,
  ): Promise<void> {
    await db
      .insert(maestroBridgeThreads)
      .values({ userId, workspaceId, conversationId })
      .onConflictDoUpdate({
        target: [
          maestroBridgeThreads.userId,
          maestroBridgeThreads.workspaceId,
        ],
        set: { conversationId, updatedAt: new Date() },
      });
  }
}
