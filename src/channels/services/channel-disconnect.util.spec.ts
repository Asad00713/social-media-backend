import type { PostTarget } from '../../drizzle/schema/posts.schema';
import { resolvedStatus, restoredStatus } from './channel-disconnect.service';

const t = (over: Partial<PostTarget>) =>
  ({ channelId: '1', platform: 'bluesky', status: 'draft', ...over }) as PostTarget;

describe('channel disconnect helpers', () => {
  it('restoredStatus never puts back a transient refreshing', () => {
    expect(restoredStatus('refreshing')).toBe('connected');
    expect(restoredStatus(null)).toBe('connected');
    expect(restoredStatus('expired')).toBe('expired');
  });

  it('resolvedStatus: pending stays, else failed or partly published', () => {
    expect(resolvedStatus([t({ status: 'failed' }), t({ status: 'draft' })])).toBeNull();
    expect(resolvedStatus([t({ status: 'failed' })])).toBe('failed');
    expect(
      resolvedStatus([t({ status: 'failed' }), t({ status: 'published' })]),
    ).toBe('partially_published');
  });
});
