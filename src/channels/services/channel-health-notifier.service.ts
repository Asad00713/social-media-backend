import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, min, count, sql } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { PLATFORM_CONFIG } from '../../drizzle/schema/channels.schema';
import { posts } from '../../drizzle/schema/posts.schema';
import { EmailOnceService } from '../../email/email-once.service';
import { AppLinks } from '../../email/links/app-links';
import { formatDay, formatWhen } from '../../email/links/format-when';
import {
  channelReconnect,
  type ChannelReconnectProps,
} from '../../email/templates/publishing/channel-reconnect';
import { NotificationEmitterService } from '../../notifications/notification-emitter.service';
import { NotifyService } from '../../notifications/notify.service';
import { RecipientsService } from '../../notifications/recipients.service';

interface HealthChannel {
  id: number;
  workspaceId: string;
  platform: string;
  accountName: string;
  /** `business_account`; shown as `Business account`. Left out when unknown. */
  accountType?: string | null;
}

const DAY_SECONDS = 24 * 60 * 60;
const EXPIRED_CLAIM_TTL_S = 7 * DAY_SECONDS;
const EXPIRING_CLAIM_TTL_S = 30 * DAY_SECONDS;
const DEFAULT_TIMEZONE = 'UTC';

function platformNameOf(platform: string): string {
  if (platform === 'twitter') return 'X';
  return (
    (PLATFORM_CONFIG as Record<string, { name: string } | undefined>)[platform]
      ?.name ?? platform
  );
}

function accountTypeLabel(accountType: string | null | undefined): string {
  const words = (accountType ?? '').replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

/**
 * C2: tells a workspace's owner and admins that a channel needs reconnecting,
 * once it has expired and a week and a day before it does. Callers are the
 * token refresh job and the daily expiry scan; neither may fail or stall
 * because of email, so nothing here throws.
 *
 * Each email is claimed in Redis per channel and expiry episode, because a
 * channel stays expired across many refresh runs and several replicas.
 */
@Injectable()
export class ChannelHealthNotifier {
  private readonly logger = new Logger(ChannelHealthNotifier.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly notify: NotifyService,
    private readonly recipients: RecipientsService,
    private readonly once: EmailOnceService,
    private readonly links: AppLinks,
    private readonly emitter: NotificationEmitterService,
  ) {}

  /**
   * The channel just moved to `expired` (the caller saw the transition). The
   * day claim stops a channel that flaps between connected and expired from
   * mailing every time; a later day sends again.
   */
  async expired(channel: HealthChannel, at: Date): Promise<void> {
    try {
      const day = at.toISOString().slice(0, 10);
      if (
        !(await this.once.claim(
          `channel-expired.${channel.id}.${day}`,
          EXPIRED_CLAIM_TTL_S,
        ))
      ) {
        return;
      }
      const ctx = await this.context(channel);
      const platformName = platformNameOf(channel.platform);
      const time = formatWhen(at, ctx.timeZone)
        .replace(/^.* at /, '')
        .replace(/ \S+$/, '');
      const props = this.props(channel, ctx, {
        kind: 'expired',
        statusLine: `${platformName} · disconnected today, ${time}`,
      });
      for (const r of ctx.admins) {
        await this.notify.notify({
          userId: r.id,
          workspaceId: channel.workspaceId,
          event: 'channel_health',
          bell: () =>
            this.emitter.tokenExpired(r.id, platformName, channel.accountName),
          email: {
            template: channelReconnect,
            props,
            idempotencyKey: `channel-expired.${channel.id}.${at.getTime()}.${r.id}`,
          },
        });
      }
    } catch (err) {
      this.fail('expired', channel, err);
    }
  }

  /**
   * The refresh token ends on `endsAt`. Stage `7` covers 2 to 7 days left,
   * stage `1` one day or less; each goes out once per token. Email only: the
   * bell is for the expiry itself.
   */
  async expiring(
    channel: HealthChannel & { refreshTokenIssuedAt: Date },
    daysLeft: number,
    endsAt: Date,
  ): Promise<void> {
    try {
      // Access that already ended is the refresh job's `expired` mail.
      if (endsAt.getTime() <= Date.now()) return;
      const stage = daysLeft <= 1 ? '1' : '7';
      const claimKey = `channel-expiring.${channel.id}.${new Date(channel.refreshTokenIssuedAt).getTime()}.${stage}`;
      if (!(await this.once.claim(claimKey, EXPIRING_CLAIM_TTL_S))) return;
      const ctx = await this.context(channel);
      const endsOn = formatDay(endsAt, ctx.timeZone);
      const props = this.props(channel, ctx, {
        kind: 'expiring',
        statusLine: `${platformNameOf(channel.platform)} · access ends ${endsOn}`,
        endsOn,
      });
      for (const r of ctx.admins) {
        await this.notify.notify({
          userId: r.id,
          workspaceId: channel.workspaceId,
          event: 'channel_health',
          email: {
            template: channelReconnect,
            props,
            idempotencyKey: `${claimKey}.${r.id}`,
          },
        });
      }
    } catch (err) {
      this.fail('expiring', channel, err);
    }
  }

  private async context(channel: HealthChannel) {
    const [admins, workspace, queued] = await Promise.all([
      this.recipients.admins(channel.workspaceId),
      this.recipients.workspace(channel.workspaceId),
      this.waiting(channel),
    ]);
    return {
      admins,
      timeZone: workspace?.timezone || DEFAULT_TIMEZONE,
      ...queued,
    };
  }

  /** Scheduled posts whose targets include the channel (targets hold it as a string id). */
  private async waiting(
    channel: HealthChannel,
  ): Promise<{ waiting: number; next: Date | null }> {
    const [row] = await this.db
      .select({ n: count(), next: min(posts.scheduledAt) })
      .from(posts)
      .where(
        and(
          eq(posts.workspaceId, channel.workspaceId),
          eq(posts.status, 'scheduled'),
          sql`${posts.targets} @> ${JSON.stringify([{ channelId: String(channel.id) }])}::jsonb`,
        ),
      );
    const waiting = Number(row?.n ?? 0);
    return {
      waiting,
      next: waiting > 0 && row?.next ? new Date(row.next) : null,
    };
  }

  private props(
    channel: HealthChannel,
    ctx: { timeZone: string; waiting: number; next: Date | null },
    part: Pick<ChannelReconnectProps, 'kind' | 'statusLine' | 'endsOn'>,
  ): ChannelReconnectProps {
    return {
      ...part,
      platform: channel.platform,
      platformName: platformNameOf(channel.platform),
      handle: channel.accountName,
      accountType: accountTypeLabel(channel.accountType),
      waiting: ctx.waiting,
      nextWhen: ctx.next ? formatWhen(ctx.next, ctx.timeZone) : null,
      reconnectUrl: this.links.channels(channel.workspaceId),
    };
  }

  private fail(what: string, channel: HealthChannel, err: unknown): void {
    this.logger.warn(
      `Reconnect ${what} email for channel ${channel.id} failed: ${(err as Error)?.message ?? String(err)}`,
    );
  }
}
