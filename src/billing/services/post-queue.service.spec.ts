import { PostQueueService, buildQueuedTargetJson } from './post-queue.service';
import { SubscriptionLookupService } from './subscription-lookup.service';

describe('buildQueuedTargetJson', () => {
  // posts.targets[].channelId is written as String(channel.id)
  // (post.service.ts:144) even though social_media_channels.id is a bigint.
  // A numeric probe would match nothing and the limit would never fire.
  it('stringifies a numeric channel id', () => {
    expect(buildQueuedTargetJson(12345)).toBe('[{"channelId":"12345"}]');
  });

  it('leaves an already-string channel id alone', () => {
    expect(buildQueuedTargetJson('12345')).toBe('[{"channelId":"12345"}]');
  });

  it('probes only channelId, so a target matches whatever else it carries', () => {
    const parsed = JSON.parse(buildQueuedTargetJson('7')) as Record<
      string,
      unknown
    >[];
    expect(Object.keys(parsed[0])).toEqual(['channelId']);
  });
});

describe('PostQueueService.enforceQueueLimit', () => {
  // These exercise the real control flow of enforceQueueLimit (early exits,
  // the Promise.all fan-out, and the deterministic scan over the results)
  // without touching the database: countQueuedForChannel — a public instance
  // method — is stubbed per test. The repo has no existing pattern for
  // mocking `db` directly, so this is the seam available; it does not cover
  // the actual SQL/jsonb containment query itself (that is covered by the
  // buildQueuedTargetJson tests above, which pin the exact string the query
  // depends on).
  function makeService(planLimits: { queuedPostsPerChannel: number }) {
    const lookup = {
      findByWorkspaceId: jest.fn().mockResolvedValue({ planCode: 'FREE' }),
      getPlanLimits: jest.fn().mockResolvedValue(planLimits),
    } as unknown as SubscriptionLookupService;

    return new PostQueueService(lookup);
  }

  it('returns without querying when channelIds is empty', async () => {
    const service = makeService({ queuedPostsPerChannel: 10 });
    const spy = jest.spyOn(service, 'countQueuedForChannel');

    await expect(
      service.enforceQueueLimit('ws-1', []),
    ).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns without querying when the plan is unlimited', async () => {
    const service = makeService({ queuedPostsPerChannel: -1 });
    const spy = jest.spyOn(service, 'countQueuedForChannel');

    await expect(
      service.enforceQueueLimit('ws-1', ['1', '2', '3']),
    ).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('runs the per-channel counts concurrently, not sequentially', async () => {
    const service = makeService({ queuedPostsPerChannel: 10 });
    const order: string[] = [];

    jest
      .spyOn(service, 'countQueuedForChannel')
      .mockImplementation(async (_workspaceId, channelId) => {
        order.push(`start:${channelId}`);
        // Channel "1" resolves slower than "2" — if the calls were awaited
        // sequentially inside a for-loop, "2" could never start before "1"
        // finishes. Under Promise.all, both starts are recorded before
        // either finish.
        await new Promise((resolve) =>
          setTimeout(resolve, channelId === '1' ? 10 : 0),
        );
        order.push(`end:${channelId}`);
        return 0;
      });

    await service.enforceQueueLimit('ws-1', ['1', '2']);

    expect(order.indexOf('start:2')).toBeLessThan(order.indexOf('end:1'));
  });

  it('names the offending channel in the refusal message', async () => {
    const service = makeService({ queuedPostsPerChannel: 5 });
    jest.spyOn(service, 'countQueuedForChannel').mockResolvedValue(5);

    await expect(
      service.enforceQueueLimit('ws-1', ['channel-A']),
    ).rejects.toThrow(/channel-A/);
  });

  it('names the FIRST over-limit channel in caller order, not settle order', async () => {
    const service = makeService({ queuedPostsPerChannel: 5 });

    jest
      .spyOn(service, 'countQueuedForChannel')
      .mockImplementation(async (_workspaceId, channelId) => {
        if (channelId === 'slow-but-first') {
          // Resolves last, but is first in the channelIds array — the
          // thrown message must still name this one, proving the scan
          // is keyed on array order rather than promise settle order.
          await new Promise((resolve) => setTimeout(resolve, 10));
          return 5;
        }
        return 5; // also over the limit, resolves immediately
      });

    await expect(
      service.enforceQueueLimit('ws-1', ['slow-but-first', 'fast-but-second']),
    ).rejects.toThrow(/slow-but-first/);
  });

  it('does not throw when every channel is under its ceiling', async () => {
    const service = makeService({ queuedPostsPerChannel: 5 });
    jest.spyOn(service, 'countQueuedForChannel').mockResolvedValue(2);

    await expect(
      service.enforceQueueLimit('ws-1', ['1', '2']),
    ).resolves.toBeUndefined();
  });
});
