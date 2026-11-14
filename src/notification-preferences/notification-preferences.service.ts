import { BadRequestException, Injectable } from '@nestjs/common';
import { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import {
  NOTIFICATION_EVENT_KEYS,
  NOTIFICATION_EVENTS,
  type ChannelPreference,
  type ChannelRule,
  type NotificationPreferenceDto,
  type NotificationPreferencesResponse,
  type PreferenceChange,
  type PreferenceChannel,
  type PreferenceEventKey,
} from './notification-events';
import {
  NotificationPreferencesRepository,
  type PreferenceOverride,
} from './notification-preferences.repository';

const CHANNEL_NAME: Record<PreferenceChannel, string> = {
  email: 'email',
  app: 'in-app',
};

function rejection(
  code: 'NOTIFICATION_CHANNEL_LOCKED' | 'NOTIFICATION_CHANNEL_UNAVAILABLE',
  message: string,
): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code,
    message,
  });
}

function overrideOf(
  rows: PreferenceOverride[],
  event: PreferenceEventKey,
  channel: PreferenceChannel,
): boolean | undefined {
  return rows.find((r) => r.event === event && r.channel === channel)?.enabled;
}

@Injectable()
export class NotificationPreferencesService {
  constructor(
    private readonly repo: NotificationPreferencesRepository,
    private readonly roles: WorkspaceRoleService,
  ) {}

  /**
   * Whether `userId` should be notified of `event` on `channel` right now. Called
   * at send time, so an unsubscribe or a removal after enqueue is honoured.
   * Order: unavailable channel, locked channel, membership, override, default.
   * `workspaceId` null means an account-level event: no membership check.
   */
  async shouldSend(
    userId: string,
    workspaceId: string | null,
    event: PreferenceEventKey,
    channel: PreferenceChannel,
  ): Promise<boolean> {
    const rule = NOTIFICATION_EVENTS[event][channel];
    if (!rule) return false;
    if (rule.locked) return true;
    if (workspaceId !== null) {
      const role = await this.roles.getRole(workspaceId, userId);
      if (!role) return false;
    }
    const rows = await this.repo.findForUser(userId, workspaceId);
    return overrideOf(rows, event, channel) ?? rule.default;
  }

  /** The caller's switches for every workspace-scope event, catalogue order. */
  async list(
    userId: string,
    workspaceId: string,
  ): Promise<NotificationPreferencesResponse> {
    const rows = await this.repo.findForUser(userId, workspaceId);
    const view = (
      event: PreferenceEventKey,
      channel: PreferenceChannel,
      rule: ChannelRule | null,
    ): ChannelPreference | null =>
      rule && {
        locked: rule.locked,
        enabled: rule.locked
          ? true
          : (overrideOf(rows, event, channel) ?? rule.default),
      };
    const events: NotificationPreferenceDto[] = NOTIFICATION_EVENT_KEYS.map(
      (event) => {
        const d = NOTIFICATION_EVENTS[event];
        return {
          event,
          email: view(event, 'email', d.email),
          app: view(event, 'app', d.app),
        };
      },
    );
    return { workspaceId, events };
  }

  /**
   * Applies the changes, then returns the full updated list. Every change is
   * validated first, so a rejected batch writes nothing.
   */
  async update(
    userId: string,
    workspaceId: string,
    changes: PreferenceChange[],
  ): Promise<NotificationPreferencesResponse> {
    for (const { event, channel } of changes) {
      const { label } = NOTIFICATION_EVENTS[event];
      const rule = NOTIFICATION_EVENTS[event][channel];
      if (!rule) {
        throw rejection(
          'NOTIFICATION_CHANNEL_UNAVAILABLE',
          `${label} has no ${CHANNEL_NAME[channel]} notifications.`,
        );
      }
      if (rule.locked) {
        throw rejection(
          'NOTIFICATION_CHANNEL_LOCKED',
          `${label} ${CHANNEL_NAME[channel]} notifications can't be turned off.`,
        );
      }
    }
    for (const { event, channel, enabled } of changes) {
      await this.repo.upsert(userId, workspaceId, event, channel, enabled);
    }
    return this.list(userId, workspaceId);
  }

  /**
   * Turns one event's email off for a recipient: the unsubscribe-link action.
   * An event with no email, or a locked one, is left alone: there is nothing
   * the person can switch off.
   */
  async disableEmail(
    userId: string,
    workspaceId: string | null,
    event: PreferenceEventKey,
  ): Promise<void> {
    const rule = NOTIFICATION_EVENTS[event].email;
    if (!rule || rule.locked) return;
    await this.repo.upsert(userId, workspaceId, event, 'email', false);
  }
}
