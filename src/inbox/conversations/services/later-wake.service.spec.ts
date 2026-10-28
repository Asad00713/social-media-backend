import { LaterWakeService } from './later-wake.service';

function build() {
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const service = new LaterWakeService(
    queue as never,
    {} as never,
    {} as never,
  );
  return { service, queue };
}

describe('LaterWakeService.schedule', () => {
  const now = new Date('2026-10-26T12:00:00Z');

  it('adds a delayed wake job with a colon-free id', async () => {
    const { service, queue } = build();
    const until = new Date('2026-10-27T04:00:00Z');
    await service.schedule('c1', until, now);
    expect(queue.add).toHaveBeenCalledWith(
      'wake',
      { conversationId: 'c1', laterUntil: '2026-10-27T04:00:00.000Z' },
      {
        jobId: 'inbox-later-c1-1793073600000',
        delay: 57_600_000,
        attempts: 3,
        removeOnComplete: true,
      },
    );
    expect(
      (queue.add.mock.calls[0] as [string, unknown, { jobId: string }])[2]
        .jobId,
    ).not.toContain(':');
  });

  it('uses delay 0 for a time in the past', async () => {
    const { service, queue } = build();
    await service.schedule('c1', new Date('2026-10-26T11:00:00Z'), now);
    expect(
      (queue.add.mock.calls[0] as [string, unknown, { delay: number }])[2]
        .delay,
    ).toBe(0);
  });
});
