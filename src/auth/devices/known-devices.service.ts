import { createHash } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, gt, ne, sql } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { knownDevices } from '../../drizzle/schema/known-devices.schema';
import { AppLinks } from '../../email/links/app-links';
import { formatWhen } from '../../email/links/format-when';
import { NEW_SIGN_IN } from '../../email/templates/security/new-sign-in';
import { EmailTokensService } from '../../email/tokens/email-tokens.service';
import { NotificationEmitterService } from '../../notifications/notification-emitter.service';
import { NotifyService } from '../../notifications/notify.service';
import { RecipientsService } from '../../notifications/recipients.service';
import { GeoipService } from '../services/geoip.service';
import { deviceLabel } from './device-label';

export type DeviceSighting = 'known' | 'first' | 'new';

export interface SignInContext {
  ip: string | null;
  userAgent: string | null;
}

export { deviceLabel };

/** The client address: the first of a proxy list, IPv4-in-IPv6 unmapped. */
function clientIp(ip: string | null): string | null {
  const first = ip?.split(',')[0].trim();
  if (!first) return null;
  return first.startsWith('::ffff:') ? first.slice(7) : first;
}

/**
 * The browsers each person signs in from (spec §7.4). A sign-in from a device
 * the person has never used, when they already have one, sends the A6 email
 * and the `newLogin` bell. The very first device is recorded silently, so
 * deploy day and signup send nothing.
 *
 * Sign-in paths call `track` once the session exists (after the refresh
 * token is minted), never before: device tracking must never block or fail a
 * login, and a sign-in that fails late must not leave a device behind.
 */
@Injectable()
export class KnownDevicesService {
  private readonly logger = new Logger(KnownDevicesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly geoip: GeoipService,
    private readonly notify: NotifyService,
    private readonly recipients: RecipientsService,
    private readonly emitter: NotificationEmitterService,
    private readonly tokens: EmailTokensService,
    private readonly links: AppLinks,
  ) {}

  /** Returns 'known' | 'first' (silently recorded) | 'new' (recorded, A6 sent). */
  async seen(
    userId: string,
    deviceId: string,
    ctx: SignInContext,
    opts: { silent?: boolean } = {},
  ): Promise<DeviceSighting> {
    const deviceHash = createHash('sha256').update(deviceId).digest('hex');
    const now = new Date();

    const touched = await this.db
      .update(knownDevices)
      .set({ lastSeenAt: now })
      .where(
        and(
          eq(knownDevices.userId, userId),
          eq(knownDevices.deviceHash, deviceHash),
        ),
      )
      .returning({ userId: knownDevices.userId });
    if (touched.length > 0) return 'known';

    // Any row now is another device: this one was not found above.
    const other = await this.db
      .select({ userId: knownDevices.userId })
      .from(knownDevices)
      .where(eq(knownDevices.userId, userId))
      .limit(1);

    const ip = clientIp(ctx.ip);
    const country = (await this.geoip.lookup(ip))?.country ?? null;
    const label = deviceLabel(ctx.userAgent);

    // Everything the alert needs that can fail runs BEFORE the insert: once
    // the row exists every later sign-in reads 'known', so a failure after it
    // would lose the alert for good. A failure here leaves no row, and the
    // next sign-in from this device tries again.
    const alert =
      !opts.silent && other.length > 0
        ? {
            timeZone: await this.recipients.userTimezone(userId),
            token: this.tokens.securityToken({ uid: userId, act: 'not_me' }),
          }
        : null;

    // Two sign-ins from one new device race here: only the insert that lands
    // sends the email.
    const inserted = await this.db
      .insert(knownDevices)
      .values({ userId, deviceHash, label, country })
      .onConflictDoNothing()
      .returning({ userId: knownDevices.userId });
    if (inserted.length === 0) return 'known';
    if (!alert) return 'first';

    await this.alertNewDevice(userId, {
      deviceHash,
      label,
      country,
      ip,
      now,
      ...alert,
    });
    return 'new';
  }

  /**
   * Is this browser trusted to skip the second factor (spec §7.2)? Only
   * while its row's `mfa_trusted_until` is ahead.
   */
  async isMfaTrusted(userId: string, deviceId: string): Promise<boolean> {
    const deviceHash = createHash('sha256').update(deviceId).digest('hex');
    const rows = await this.db
      .select({ userId: knownDevices.userId })
      .from(knownDevices)
      .where(
        and(
          eq(knownDevices.userId, userId),
          eq(knownDevices.deviceHash, deviceHash),
          gt(knownDevices.mfaTrustedUntil, sql`now()`),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * After a correct second factor: trust this browser for `days` (awaited
   * upsert, R9). It is also that sign-in's device sighting (B4): when the
   * upsert INSERTED the row and the person has another device, the A6
   * alert goes out detached, exactly as `seen()` would have sent it. Calling
   * track() as well would read this fresh row as "known" and lose the A6.
   */
  async markMfaTrusted(
    userId: string,
    deviceId: string,
    ctx: SignInContext,
    days = 30,
  ): Promise<void> {
    const deviceHash = createHash('sha256').update(deviceId).digest('hex');
    const label = deviceLabel(ctx.userAgent);
    const now = new Date();
    const until = sql`now() + make_interval(days => ${days})`;
    const [row] = await this.db
      .insert(knownDevices)
      .values({ userId, deviceHash, label, mfaTrustedUntil: until })
      .onConflictDoUpdate({
        target: [knownDevices.userId, knownDevices.deviceHash],
        set: { mfaTrustedUntil: until, lastSeenAt: sql`now()` },
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    if (!row?.inserted) return;

    // Detached: GeoIP and the alert must not hold up the sign-in.
    void (async () => {
      const other = await this.db
        .select({ userId: knownDevices.userId })
        .from(knownDevices)
        .where(
          and(
            eq(knownDevices.userId, userId),
            ne(knownDevices.deviceHash, deviceHash),
          ),
        )
        .limit(1);
      const ip = clientIp(ctx.ip);
      const country = (await this.geoip.lookup(ip))?.country ?? null;
      if (country) {
        await this.db
          .update(knownDevices)
          .set({ country })
          .where(
            and(
              eq(knownDevices.userId, userId),
              eq(knownDevices.deviceHash, deviceHash),
            ),
          );
      }
      if (other.length === 0) return; // the first device ever: silent
      await this.alertNewDevice(userId, {
        deviceHash,
        label,
        country,
        ip,
        now,
        timeZone: await this.recipients.userTimezone(userId),
        token: this.tokens.securityToken({ uid: userId, act: 'not_me' }),
      });
    })().catch((error: unknown) => {
      this.logger.warn(
        `Trusted-device sighting failed for user ${userId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    });
  }

  /** A6 and the `newLogin` bell for a device first seen just now. */
  private async alertNewDevice(
    userId: string,
    d: {
      deviceHash: string;
      label: string;
      country: string | null;
      ip: string | null;
      now: Date;
      timeZone: string;
      token: string;
    },
  ): Promise<void> {
    // NotifyService.notify never throws.
    await this.notify.notify({
      userId,
      workspaceId: null,
      event: 'security_alert',
      bell: () =>
        this.emitter.newLogin(userId, d.label, d.country ?? undefined),
      email: {
        template: NEW_SIGN_IN,
        props: {
          when: formatWhen(d.now, d.timeZone),
          device: d.label,
          location: d.country,
          ip: d.ip,
          notMeUrl: this.links.api(`/email/security/${d.token}`),
        },
        idempotencyKey: `new-sign-in.${userId}.${d.deviceHash.slice(0, 16)}`,
      },
    });
  }

  /**
   * `seen` for a sign-in path: detached, so a slow GeoIP lookup never holds
   * up the response, and never throws. A failure is logged without the IP
   * address or user agent.
   */
  track(
    userId: string,
    deviceId: string,
    ctx: SignInContext,
    opts: { silent?: boolean } = {},
  ): void {
    void this.seen(userId, deviceId, ctx, opts).catch((error: unknown) => {
      this.logger.warn(
        `Device tracking failed for user ${userId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    });
  }
}
