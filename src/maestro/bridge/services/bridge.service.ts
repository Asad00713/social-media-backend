import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { db } from '../../../drizzle/db';
import { maestroChannelLinks } from '../../../drizzle/schema/maestro-links.schema';
import { WorkspaceService } from '../../../workspace/workspace.service';
import { BridgeLinkService } from './bridge-link.service';

/**
 * Facade the in-app "Connect Maestro" UI talks to: builds the Telegram deep link
 * (with a signed link token) and lists a user's bridge connections. Keeps the
 * controller thin and the link-token mechanics in `BridgeLinkService`.
 */
@Injectable()
export class BridgeService {
  constructor(
    private readonly links: BridgeLinkService,
    private readonly workspaces: WorkspaceService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Issue a `t.me` deep link that, when opened, binds the Telegram account to
   * this user + workspace. Validates workspace ownership first (throws if the
   * caller doesn't own it) so a token can't be minted for someone else's space.
   */
  async telegramDeepLink(userId: string, workspaceId: string): Promise<string> {
    await this.workspaces.findOne(workspaceId, userId);
    const token = this.links.issueLinkToken(userId, workspaceId);
    // BotFather usernames are bare (no `@`); a stray `@` or surrounding spaces in
    // the env would yield `t.me/@name` → "username not found". Normalise here.
    const bot = (
      this.config.get<string>(
        'MAESTRO_TELEGRAM_BOT_USERNAME',
        'ScheduraMaestroBot',
      ) || ''
    )
      .trim()
      .replace(/^@+/, '');
    return `https://t.me/${bot}?start=${token}`;
  }

  /**
   * Issue a `wa.me` deep link that prefills `/connect <token>` to the central
   * Maestro WhatsApp number — same command shape as Telegram's `/start`. The
   * user just taps Send; the webhook binds their wa_id to this user + workspace.
   * Validates workspace ownership first.
   */
  async whatsappDeepLink(userId: string, workspaceId: string): Promise<string> {
    await this.workspaces.findOne(workspaceId, userId);
    const token = this.links.issueLinkToken(userId, workspaceId);
    const number = (
      this.config.get<string>('MAESTRO_WHATSAPP_NUMBER') || ''
    ).replace(/\D/g, '');
    const text = encodeURIComponent(`/connect ${token}`);
    return `https://wa.me/${number}?text=${text}`;
  }

  async listLinks(userId: string) {
    const rows = await db
      .select()
      .from(maestroChannelLinks)
      .where(eq(maestroChannelLinks.userId, userId));
    return rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      displayName: r.displayName,
      defaultWorkspaceId: r.defaultWorkspaceId,
      status: r.status,
    }));
  }
}
