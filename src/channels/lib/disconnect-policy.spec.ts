import { SUPPORTED_PLATFORMS } from '../../drizzle/schema/channels.schema';
import {
  CHANNEL_RESTORE_WINDOW_MS,
  MUST_DELETE_ON_DISCONNECT,
  mustDeleteOnDisconnect,
} from './disconnect-policy';

describe('disconnect policy', () => {
  it('has a ruling, with its source, for every supported platform', () => {
    for (const p of SUPPORTED_PLATFORMS) {
      expect(MUST_DELETE_ON_DISCONNECT[p]).toBeDefined();
      expect(MUST_DELETE_ON_DISCONNECT[p].source.length).toBeGreaterThan(20);
    }
  });

  it('deletes where the policy requires it (YouTube 7 days, Pinterest no storage, LinkedIn)', () => {
    expect(mustDeleteOnDisconnect('youtube')).toBe(true);
    expect(mustDeleteOnDisconnect('pinterest')).toBe(true);
    expect(mustDeleteOnDisconnect('linkedin')).toBe(true);
  });

  it('keeps history where the policy is silent on disconnect', () => {
    for (const p of [
      'facebook',
      'instagram',
      'threads',
      'tiktok',
      'twitter',
      'bluesky',
      'mastodon',
    ]) {
      expect(mustDeleteOnDisconnect(p)).toBe(false);
    }
  });

  it('an unknown platform is deleted: no data kept without a ruling', () => {
    expect(mustDeleteOnDisconnect('myspace')).toBe(true);
  });

  it('the undo window is ten minutes', () => {
    expect(CHANNEL_RESTORE_WINDOW_MS).toBe(600_000);
  });
});
