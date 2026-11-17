import { Inject, Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { DRIZZLE } from '../../drizzle/drizzle.module';
import { workspace } from '../../drizzle/schema/workspace.schema';
import {
  NOTIFICATION_EVENTS,
  type PreferenceEventKey,
} from '../../notification-preferences/notification-events';
import { AppLinks } from '../links/app-links';
import { eventOf } from '../templates/define-template';
import { EmailTokensService } from '../tokens/email-tokens.service';
import type {
  AnyTemplateDef,
  FooterContext,
  FooterLink,
} from '../templates/types';
import type { EmailRecipient } from './email-job';
import { liveWorkspaces } from '../../posts/soft-delete/soft-delete';

/**
 * Footer line 1 and the links row, per footer kind (spec §4.1). A template's
 * `footerReason` overrides line 1 for every kind; its `extraFooterLinks` go
 * after "Help center", i.e. just before the trailing "Privacy".
 * A misconfigured template or a vanished workspace is an UnrecoverableError:
 * no retry would fix it.
 */
@Injectable()
export class EmailFooterService {
  constructor(
    private readonly links: AppLinks,
    @Inject(DRIZZLE) private readonly db: DbType,
    private readonly tokens: EmailTokensService,
  ) {}

  async build(
    def: AnyTemplateDef,
    props: unknown,
    to: EmailRecipient,
    workspaceId: string | null,
  ): Promise<FooterContext> {
    const help: FooterLink = { label: 'Help center', href: this.links.help() };
    const privacy: FooterLink = {
      label: 'Privacy',
      href: this.links.privacy(),
    };
    const override = def.footerReason?.(props);
    const extra =
      typeof def.extraFooterLinks === 'function'
        ? def.extraFooterLinks(this.links)
        : (def.extraFooterLinks ?? []);
    const key = eventOf(def, props);
    const footer = (reason: string, lead: FooterLink[]): FooterContext => ({
      reason: override ?? reason,
      links: [...lead, ...extra, privacy],
    });

    switch (def.footer) {
      case 'notification': {
        const event = key
          ? NOTIFICATION_EVENTS[key as PreferenceEventKey]
          : undefined;
        if (!event || !workspaceId) {
          throw new UnrecoverableError(
            `Template ${def.id} has a notification footer but no catalogue event or workspace`,
          );
        }
        const manage: FooterLink = {
          label: 'Manage notifications',
          href: this.links.notifications(workspaceId),
        };
        const reason =
          override ??
          `You get this because ${event.label} → Email is on for ${await this.workspaceName(workspaceId)}.`;
        return footer(reason, [manage, help]);
      }
      case 'security':
        return footer('Security emails can’t be turned off.', [help]);
      case 'account':
        return footer('Account emails can’t be turned off.', [help]);
      case 'billing':
        return footer(
          'Billing emails go to workspace owners and can’t be turned off.',
          [{ label: 'Billing help', href: this.links.billingHelp() }],
        );
      case 'plain':
        if (override === undefined) {
          throw new UnrecoverableError(
            `Template ${def.id} has a plain footer but no footerReason`,
          );
        }
        // F2 (spec 4.1) is the one plain-footer email a person can switch off:
        // its links row leads with the one-click unsubscribe link.
        if (key === 'inactivity_reminder') {
          if (!to.userId) {
            throw new UnrecoverableError(
              `Template ${def.id} needs a user to unsubscribe`,
            );
          }
          const token = this.tokens.unsubscribeToken({
            uid: to.userId,
            ws: null,
            ev: 'inactivity_reminder',
          });
          return footer(override, [
            {
              label: 'Stop these reminders',
              href: this.links.api(`/email/unsubscribe/${token}`),
            },
            help,
          ]);
        }
        return footer(override, [help]);
    }
  }

  /**
   * Read on every attempt, not frozen at enqueue: a rename between attempts
   * changes the payload, which Resend answers with invalid_idempotent_request
   * and the outbox treats as already sent. Accepted: renames are rare.
   */
  private async workspaceName(workspaceId: string): Promise<string> {
    const [row] = await this.db
      .select({ name: workspace.name })
      .from(workspace)
      .where(and(eq(workspace.id, workspaceId), liveWorkspaces()))
      .limit(1);
    if (!row) {
      throw new UnrecoverableError(`Workspace ${workspaceId} no longer exists`);
    }
    return row.name;
  }
}
