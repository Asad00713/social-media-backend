import {
  NOTIFICATION_EVENT_KEYS,
  NOTIFICATION_EVENTS,
} from './notification-events';

describe('notification catalogue', () => {
  it('keeps the FE ids and defaults that overlap', () => {
    expect(NOTIFICATION_EVENTS.post_failed).toMatchObject({
      email: { default: true, locked: false },
      app: { default: true, locked: true },
    });
    expect(NOTIFICATION_EVENTS.member_activity.email).toEqual({
      default: false,
      locked: false,
    });
    expect(NOTIFICATION_EVENTS.security_alert.email).toEqual({
      default: true,
      locked: true,
    });
    expect(NOTIFICATION_EVENTS.billing_alert.app).toEqual({
      default: true,
      locked: false,
    });
    expect(NOTIFICATION_EVENTS.drip_review.app).toBeNull();
    expect(NOTIFICATION_EVENTS.draft_ready.email).toBeNull();
    expect(NOTIFICATION_EVENTS.inactivity_reminder.scope).toBe('account');
  });

  it('lists the 12 workspace events in the spec order, keyed by their own id', () => {
    expect([...NOTIFICATION_EVENT_KEYS]).toEqual([
      'post_failed',
      'channel_health',
      'drip_review',
      'approval_request',
      'post_approved',
      'draft_ready',
      'member_activity',
      'inbox_assigned',
      'inbox_mention',
      'inbox_new_message',
      'billing_alert',
      'security_alert',
    ]);
    for (const [key, def] of Object.entries(NOTIFICATION_EVENTS)) {
      expect(def.key).toBe(key);
    }
    for (const key of NOTIFICATION_EVENT_KEYS) {
      expect(NOTIFICATION_EVENTS[key].scope).toBe('workspace');
    }
  });

  it('carries the Figma labels', () => {
    const labels = Object.values(NOTIFICATION_EVENTS).map((d) => d.label);
    expect(labels).toEqual([
      'Post failed',
      'Channel disconnected',
      'Drip post to review',
      'Approval requested',
      'Post approved',
      'Draft ready',
      'Member joined',
      'Conversation assigned',
      'Mentioned in a note',
      'New inbox message',
      'Billing',
      'Security',
      'Inactivity reminders',
    ]);
  });
});
