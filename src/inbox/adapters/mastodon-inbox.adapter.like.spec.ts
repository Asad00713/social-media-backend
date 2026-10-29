import type { ConfigService } from '@nestjs/config';
import { MastodonService } from '../../channels/services/mastodon.service';
import { json, mockFetch } from '../testing/fetch-mock';
import { MastodonInboxAdapter } from './mastodon-inbox.adapter';
import type { ResolvedChannel } from './inbox-adapter.interface';

const channel: ResolvedChannel = {
  id: 1,
  workspaceId: 'w1',
  platform: 'mastodon',
  platformAccountId: 'acct-1',
  accessToken: 'tok',
  metadata: { instanceUrl: 'mastodon.example' },
  username: 'me',
  accountName: 'Me',
  profilePictureUrl: null,
};

describe('MastodonInboxAdapter.likeComment', () => {
  const adapter = new MastodonInboxAdapter(
    new MastodonService({ get: () => undefined } as unknown as ConfigService),
  );
  let net: ReturnType<typeof mockFetch>;
  afterEach(() => net.restore());

  it('favourites with POST /api/v1/statuses/:id/favourite', async () => {
    net = mockFetch();
    await adapter.likeComment(channel, { platformItemId: 's1' }, true);
    expect(net.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://mastodon.example/api/v1/statuses/s1/favourite',
      headers: { Authorization: 'Bearer tok' },
    });
  });

  it('unfavourites with POST /api/v1/statuses/:id/unfavourite', async () => {
    net = mockFetch();
    await adapter.likeComment(channel, { platformItemId: 's1' }, false);
    expect(net.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://mastodon.example/api/v1/statuses/s1/unfavourite',
    });
  });

  it('throws on a refusal', async () => {
    net = mockFetch(() => json({ error: 'no' }, 422));
    await expect(
      adapter.likeComment(channel, { platformItemId: 's1' }, true),
    ).rejects.toThrow(/Mastodon favourite failed: 422/);
  });
});
