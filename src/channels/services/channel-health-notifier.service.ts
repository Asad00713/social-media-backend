import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, count, eq, gt, min, not, notInArray, sql } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import {
  PLATFORM_CONFIG,
  socialMediaChannels,
} from '../../drizzle/schema/channels.schema';
import { posts } from '../../drizzle/schema/posts.schema';
import { EmailOnceService } from '../../email/email-once.service';
import { AppLinks } from '../../email/links/app-links';
import {
  formatDay,
  formatTime,
  formatWhen,
} from '../../email/links/format-when';
import {
  channelReconnect,
  type ChannelReconnectProps,
} from '../../email/templates/publishing/channel-reconnect';
import { NotificationEmitterService } from '../../notifications/notification-emitter.service';
import { NotifyService } from '../../notifications/notify.service';
import { RecipientsService } from '../../notifications/recipients.service';
import { DISCONNECTED_STATUS, liveChannel } from '../lib/live-channel';
import { livePosts } from '../../posts/soft-delete/soft-delete';

interface HealthChannel {
  id: number;
  workspaceId: string;
  platform: string;
  accountName: string;
  /** The `@handle`, shown instead of `accountName` when there is one. */
  username?: string | null;
  /** `business_account`; shown as `Business` in `Instagram Business`. Left out when unknown. */
  accountType?: string | null;
}

/** What a writer changes besides the status, e.g. `lastError`. */
type ExpiredFields = Partial<typeof socialMediaChannels.$inferInsert>;

const DAY_SECONDS = 24 * 60 * 60;
const EXPIRED_CLAIM_TTL_S = 7 * DAY_SECONDS;
const EXPIRING_CLAIM_TTL_S = 30 * DAY_SECONDS;
const DEFAULT_TIMEZONE = 'UTC';

/** Short names for the account type, as the Figma card shows them. */
const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  business_account: 'Business',
  page: 'Page',
  profile: 'Profile',
  channel: 'Channel',
  group: 'Group',
};

function platformNameOf(platform: string): string {
  if (platform === 'twitter') return 'X';
  return (
    (PLATFORM_CONFIG as Record<string, { name: string } | undefined>)[platform]
      ?.name ?? platform
  );
}

function handleOf(channel: HealthChannel): string {
  const username = channel.username?.trim().replace(/^@/, '');
  return username ? `@${username}` : channel.accountName;
}

/**
 * C2: tells a workspace's owner and admins that a channel needs reconnecting,
 * once it has expired and a week and a day before it does. Callers are the
 * writers of `connection_status = 'expired'`, the token refresh job and the
 * daily expiry scan; none may fail or stall because of email, so the email
 * methods never throw.
 *
 * Each email is claimed in Redis per channel and expiry episode, because a
 * channel stays expired across many refresh runs and several replicas. The
 * claim is the last thing before the send, after everything that can throw,
 * so a failed lookup never uses it up.
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
   * The one place a channel moves to `expired`: a compare-and-set, so only the
   * writer that actually flips it (not one that finds it already expired)
   * sends the email. `fields` are the writer's own columns (`lastError`, ...);
   * they are written either way, as each writer did before. A database error
   * is the caller's, as it was. The email runs in the background, so a slow
   * Redis, queue or lookup never delays a publish; it never throws.
   *
   * A disconnected channel (soft disconnect, 0081) is history: it is neither
   * flipped nor written, so it keeps that status and never emails.
   */
  async markExpired(channelId: number, fields: ExpiredFields): Promise<void> {
    const set = { ...fields, connectionStatus: 'expired' };
    const flipped = await this.db
      .update(socialMediaChannels)
      .set(set)
      .where(
        and(
          eq(socialMediaChannels.id, channelId),
          notInArray(socialMediaChannels.connectionStatus, [
            'expired',
            DISCONNECTED_STATUS,
          ]),
        ),
      )
      .returning({
        id: socialMediaChannels.id,
        workspaceId: socialMediaChannels.workspaceId,
        platform: socialMediaChannels.platform,
        accountName: socialMediaChannels.accountName,
        username: socialMediaChannels.username,
        accountType: socialMediaChannels.accountType,
      });
    if (flipped.length === 0) {
      await this.db
        .update(socialMediaChannels)
        .set(set)
        .where(and(eq(socialMediaChannels.id, channelId), liveChannel()));
      return;
    }
    const channel = { ...flipped[0], id: Number(flipped[0].id) };
    void this.expired(
      channel,
      fields.updatedAt instanceof Date ? fields.updatedAt : new Date(),
    ).catch((err) => this.fail('expired', channel, err));
  }

  /**
   * The channel just moved to `expired` (the caller saw the transition). The
   * day claim stops a channel that flaps between connected and expired from
   * mailing every time; a later day sends again.
   */
  async expired(channel: HealthChannel, at: Date): Promise<void> {
    try {
      const ctx = await this.context(channel);
      const platformName = platformNameOf(channel.platform);
      const label = ACCOUNT_TYPE_LABEL[channel.accountType ?? ''];
      const network = label ? `${platformName} ${label}` : platformName;
      const props = this.props(channel, ctx, {
        kind: 'expired',
        statusLine: `${network} · disconnected today, ${formatTime(at, ctx.timeZone)}`,
      });
      const claimed = await this.once.claim(
        `channel-expired.${channel.id}.${at.toISOString().slice(0, 10)}`,
        EXPIRED_CLAIM_TTL_S,
      );
      if (!claimed) return;
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
      // Access that already ended is the `expired` mail's business.
      if (endsAt.getTime() <= Date.now()) return;
      const stage = daysLeft <= 1 ? '1' : '7';
      const claimKey = `channel-expiring.${channel.id}.${new Date(channel.refreshTokenIssuedAt).getTime()}.${stage}`;
      const ctx = await this.context(channel);
      const endsOn = formatDay(endsAt, ctx.timeZone);
      const props = this.props(channel, ctx, {
        kind: 'expiring',
        statusLine: `${platformNameOf(channel.platform)} · access ends ${endsOn}`,
        endsOn,
      });
      if (!(await this.once.claim(claimKey, EXPIRING_CLAIM_TTL_S))) return;
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

  /**
   * Posts still to go out that target the channel (`targets` holds it as a
   * string id): scheduled, in the future, and with no published target on
   * this channel. A partly published post has already left `scheduled`, the
   * target test covers the rest.
   */
  private async waiting(
    channel: HealthChannel,
  ): Promise<{ waiting: number; next: Date | null }> {
    const channelId = String(channel.id);
    const [row] = await this.db
      .select({ n: count(), next: min(posts.scheduledAt) })
      .from(posts)
      .where(and(and(
          eq(posts.workspaceId, channel.workspaceId),
          eq(posts.status, 'scheduled'),
          gt(posts.scheduledAt, new Date()),
          sql`${posts.targets} @> ${JSON.stringify([{ channelId }])}::jsonb`,
          not(
            sql`${posts.targets} @> ${JSON.stringify([{ channelId, status: 'published' }])}::jsonb`,
          ),
        ), livePosts()));
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
      handle: handleOf(channel),
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
