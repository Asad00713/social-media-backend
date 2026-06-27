import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../drizzle/db';
import {
  maestroChannelLinks,
  type MaestroBridgeChannel,
  type MaestroChannelLink,
} from '../../../drizzle/schema/maestro-links.schema';
import { maestroBridgeThreads } from '../../../drizzle/schema/maestro-bridge-threads.schema';
import { secureCompare } from '../../../common/utils/encryption.util';

/** Connect links are short-lived so a leaked URL can't be reused later. */
const TOKEN_TTL_MS = 10 * 60 * 1000;

interface LinkPayload {
  u: string;
  w: string;
  exp: number;
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
 * Issues/verifies the HMAC-signed deep-link tokens used to bind an external
 * identity (Telegram user, …) to a Schedura account, and owns CRUD over
 * `maestro_channel_links`. The token is stateless (no DB round-trip to verify) —
 * tamper-proof via HMAC, time-boxed via `exp`.
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

  private sign(body: string): string {
    return createHmac('sha256', this.secret()).update(body).digest('hex');
  }

  issueLinkToken(userId: string, workspaceId: string): string {
    const payload: LinkPayload = {
      u: userId,
      w: workspaceId,
      exp: Date.now() + TOKEN_TTL_MS,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  verifyLinkToken(
    token: string,
  ): { userId: string; workspaceId: string } | null {
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!secureCompare(sig, this.sign(body))) return null;
    try {
      const payload = JSON.parse(
        Buffer.from(body, 'base64url').toString('utf8'),
      ) as LinkPayload;
      if (!payload.u || !payload.w || typeof payload.exp !== 'number') {
        return null;
      }
      if (Date.now() > payload.exp) return null;
      return { userId: payload.u, workspaceId: payload.w };
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
   * The shared Maestro conversation for a (user, workspace) — all of the user's
   * linked numbers/channels in that workspace use this one thread, so Maestro
   * keeps one continuous memory. Returns null if none exists yet.
   */
  async findThreadConversation(
    userId: string,
    workspaceId: string,
  ): Promise<string | null> {
    const [row] = await db
      .select({ conversationId: maestroBridgeThreads.conversationId })
      .from(maestroBridgeThreads)
      .where(
        and(
          eq(maestroBridgeThreads.userId, userId),
          eq(maestroBridgeThreads.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    return row?.conversationId ?? null;
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
