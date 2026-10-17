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
