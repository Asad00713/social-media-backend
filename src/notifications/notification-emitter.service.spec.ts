import { NotificationEmitterService } from './notification-emitter.service';

describe('NotificationEmitterService.draftReady', () => {
  it('creates a draft_ready notification, pushes it and the unread count', async () => {
    const created = { id: 'n1', userId: 'u1', type: 'draft_ready' };
    const notifications = {
      create: jest.fn().mockResolvedValue(created),
      getUnreadCount: jest.fn().mockResolvedValue(4),
    };
    const gateway = {
      sendNotificationToUser: jest.fn(),
      sendUnreadCountUpdate: jest.fn(),
    };
    const emitter = new NotificationEmitterService(
      notifications as any,
      gateway as any,
    );

    const result = await emitter.draftReady('u1', {
      workspaceId: 'w1',
      postId: 'p1',
      markedByName: 'Sara',
      preview: 'Launch day',
    });

    expect(result).toBe(created);
    expect(notifications.create).toHaveBeenCalledWith({
      userId: 'u1',
      type: 'draft_ready',
      title: 'Draft ready to schedule',
      message: 'Sara marked a draft ready: "Launch day"',
      priority: 'medium',
      metadata: { workspaceId: 'w1', postId: 'p1', markedByName: 'Sara' },
      actionUrl: '/w/w1/planner?post=p1',
    });
    expect(gateway.sendNotificationToUser).toHaveBeenCalledWith('u1', created);
    expect(gateway.sendUnreadCountUpdate).toHaveBeenCalledWith('u1', 4);
  });
});

describe('NotificationEmitterService inbox notifications', () => {
  function build() {
    const created = { id: 'n1' };
    const notifications = {
      create: jest.fn().mockResolvedValue(created),
      getUnreadCount: jest.fn().mockResolvedValue(2),
    };
    const gateway = {
      sendNotificationToUser: jest.fn(),
      sendUnreadCountUpdate: jest.fn(),
    };
    const emitter = new NotificationEmitterService(
      notifications as any,
      gateway as any,
    );
    return { emitter, notifications, gateway, created };
  }

  it('inboxAssigned creates inbox_assigned and pushes the unread count', async () => {
    const { emitter, notifications, gateway, created } = build();
    const result = await emitter.inboxAssigned('u1', {
      workspaceId: 'w1',
      conversationId: 'c1',
      assignedByName: 'Hina',
    });
    expect(result).toBe(created);
    expect(notifications.create).toHaveBeenCalledWith({
      userId: 'u1',
      type: 'inbox_assigned',
      title: 'Assigned to you',
      message: 'Hina assigned you a conversation',
      priority: 'medium',
      metadata: { workspaceId: 'w1', conversationId: 'c1' },
      actionUrl: '/w/w1/inbox?c=c1',
    });
    expect(gateway.sendNotificationToUser).toHaveBeenCalledWith('u1', created);
    expect(gateway.sendUnreadCountUpdate).toHaveBeenCalledWith('u1', 2);
  });

  it('inboxNoteMention creates inbox_note_mention', async () => {
    const { emitter, notifications, gateway } = build();
    await emitter.inboxNoteMention('u1', {
      workspaceId: 'w1',
      conversationId: 'c1',
      authorName: 'Hina',
    });
    expect(notifications.create).toHaveBeenCalledWith({
      userId: 'u1',
      type: 'inbox_note_mention',
      title: 'Mentioned in a note',
      message: 'Hina mentioned you in a note',
      priority: 'medium',
      metadata: { workspaceId: 'w1', conversationId: 'c1' },
      actionUrl: '/w/w1/inbox?c=c1',
    });
    expect(gateway.sendUnreadCountUpdate).toHaveBeenCalledWith('u1', 2);
  });

  it('inboxNewMessage creates a low-priority inbox_new_message', async () => {
    const { emitter, notifications } = build();
    await emitter.inboxNewMessage('u1', {
      workspaceId: 'w1',
      conversationId: 'c1',
      authorName: 'Sam',
    });
    expect(notifications.create).toHaveBeenCalledWith({
      userId: 'u1',
      type: 'inbox_new_message',
      title: 'New message',
      message: 'New message from Sam',
      priority: 'low',
      metadata: { workspaceId: 'w1', conversationId: 'c1' },
      actionUrl: '/w/w1/inbox?c=c1',
    });
  });
});
