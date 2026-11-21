import { Injectable, Logger } from '@nestjs/common';
import { AppLinks } from '../../email/links/app-links';
import { formatWhen } from '../../email/links/format-when';
import { backupCodeUsedTemplate } from '../../email/templates/security/backup-code-used';
import { backupCodesRegeneratedTemplate } from '../../email/templates/security/backup-codes-regenerated';
import type { TwoStepNoticeProps } from '../../email/templates/security/two-step-shared';
import {
  twoStepDisabledTemplate,
  type TwoStepDisabledProps,
} from '../../email/templates/security/two-step-disabled';
import { twoStepEnabledTemplate } from '../../email/templates/security/two-step-enabled';
import { twoStepFailedTemplate } from '../../email/templates/security/two-step-failed';
import type { EmailTemplateDef } from '../../email/templates/types';
import { EmailTokensService } from '../../email/tokens/email-tokens.service';
import { NotifyService } from '../../notifications/notify.service';
import { RecipientsService } from '../../notifications/recipients.service';
import type { RequestContext } from '../../users/account-security.service';
import { deviceLabel } from '../devices/device-label';
import { GeoipService } from '../services/geoip.service';

/** The device row of an email for a change support made. */
const SUPPORT_DEVICE = 'Schedura support';

/**
 * The two-step sign-in security emails (R16). Every method never throws: the
 * action it reports has already happened, and a failed email must not undo
 * or fail it. Props are built like the password-changed email (A5): the
 * time in the person's zone, the parsed device, the GeoIP country and the
 * "This wasn't me" link.
 */
@Injectable()
export class TwoFactorNotices {
  private readonly logger = new Logger(TwoFactorNotices.name);

  constructor(
    private readonly notify: NotifyService,
    private readonly recipients: RecipientsService,
    private readonly tokens: EmailTokensService,
    private readonly links: AppLinks,
    private readonly geoip: GeoipService,
  ) {}

  enabled(userId: string, ctx: RequestContext): Promise<void> {
    return this.send(
      userId,
      ctx,
      twoStepEnabledTemplate,
      {},
      `two-step-enabled.${userId}.${Date.now()}`,
    );
  }

  disabled(
    userId: string,
    ctx: RequestContext,
    by: TwoStepDisabledProps['by'],
  ): Promise<void> {
    return this.send(
      userId,
      ctx,
      twoStepDisabledTemplate,
      { by },
      `two-step-disabled.${userId}.${Date.now()}`,
    );
  }

  /**
   * Support turned two-step off (admin reset). The request came from the
   * admin's browser, not the person's, so the device row names support and
   * no location is looked up.
   */
  disabledBySupport(userId: string): Promise<void> {
    return this.send(
      userId,
      { ip: null, userAgent: null },
      twoStepDisabledTemplate,
      { by: 'support' },
      `two-step-disabled.${userId}.${Date.now()}`,
      SUPPORT_DEVICE,
    );
  }

  backupCodeUsed(
    userId: string,
    ctx: RequestContext,
    remaining: number,
  ): Promise<void> {
    return this.send(
      userId,
      ctx,
      backupCodeUsedTemplate,
      { remaining },
      `backup-code-used.${userId}.${Date.now()}`,
    );
  }

  /** Once per challenge (B7): the key is the challenge id. */
  failed(userId: string, ctx: RequestContext, cid: string): Promise<void> {
    return this.send(
      userId,
      ctx,
      twoStepFailedTemplate,
      {},
      `two-step-failed.${cid}`,
    );
  }

  regenerated(userId: string, ctx: RequestContext): Promise<void> {
    return this.send(
      userId,
      ctx,
      backupCodesRegeneratedTemplate,
      {},
      `backup-codes-regenerated.${userId}.${Date.now()}`,
    );
  }

  private async send<P extends TwoStepNoticeProps>(
    userId: string,
    ctx: RequestContext,
    template: EmailTemplateDef<P>,
    extra: Omit<P, keyof TwoStepNoticeProps>,
    idempotencyKey: string,
    device?: string,
  ): Promise<void> {
    try {
      const [timeZone, geo] = await Promise.all([
        this.recipients.userTimezone(userId),
        device ? null : this.geoip.lookup(ctx.ip),
      ]);
      const token = this.tokens.securityToken({ uid: userId, act: 'not_me' });
      const props = {
        when: formatWhen(new Date(), timeZone),
        device: device ?? deviceLabel(ctx.userAgent),
        location: geo?.country ?? null,
        notMeUrl: this.links.api('/email/security/' + token),
        ...extra,
      } as P;
      // NotifyService.notify never throws; the try covers the props.
      await this.notify.notify({
        userId,
        workspaceId: null,
        event: 'security_alert',
        email: { template, props, idempotencyKey },
      });
    } catch (err) {
      this.logger.warn(
        `${template.id} notice for user ${userId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
