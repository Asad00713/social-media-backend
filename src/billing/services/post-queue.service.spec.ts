import { buildQueuedTargetJson } from './post-queue.service';

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
