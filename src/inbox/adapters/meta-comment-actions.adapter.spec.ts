import { FacebookService } from '../../channels/services/facebook.service';
import { InstagramService } from '../../channels/services/instagram.service';
import { InboxSendError } from '../conversations/lib/send-error';
import { json, mockFetch } from '../testing/fetch-mock';
import { FacebookInboxAdapter } from './facebook-inbox.adapter';
import { InstagramInboxAdapter } from './instagram-inbox.adapter';
import type { ResolvedChannel } from './inbox-adapter.interface';

function channel(platform: 'facebook' | 'instagram'): ResolvedChannel {
  return {
    id: 1,
    workspaceId: 'w1',
    platform,
    platformAccountId: 'acct-1',
    accessToken: 'tok',
    metadata: {},
    username: 'acme',
    accountName: 'Acme',
    profilePictureUrl: null,
  };
}

describe('FacebookInboxAdapter comment actions', () => {
  const adapter = new FacebookInboxAdapter(new FacebookService());
  let net: ReturnType<typeof mockFetch>;
  afterEach(() => net.restore());

  it('likes with POST /{comment-id}/likes and unlikes with DELETE', async () => {
    net = mockFetch();
    await adapter.likeComment(
      channel('facebook'),
      { platformItemId: 'c1' },
      true,
    );
    await adapter.likeComment(
      channel('facebook'),
      { platformItemId: 'c1' },
      false,
    );
    expect(net.requests.map((r) => [r.method, r.url])).toEqual([
      ['POST', 'https://graph.facebook.com/v18.0/c1/likes?access_token=tok'],
      ['DELETE', 'https://graph.facebook.com/v18.0/c1/likes?access_token=tok'],
    ]);
  });

  it('hides with POST /{comment-id} is_hidden', async () => {
    net = mockFetch();
    await adapter.hideComment(channel('facebook'), 'c1', true);
    await adapter.hideComment(channel('facebook'), 'c1', false);
    expect(net.requests.map((r) => [r.method, r.url])).toEqual([
      [
        'POST',
        'https://graph.facebook.com/v18.0/c1?access_token=tok&is_hidden=true',
      ],
      [
        'POST',
        'https://graph.facebook.com/v18.0/c1?access_token=tok&is_hidden=false',
      ],
    ]);
  });

  it("deletes someone else's comment with DELETE /{comment-id}", async () => {
    net = mockFetch();
    await adapter.moderateDelete(channel('facebook'), 'c1');
    expect(net.requests[0]).toMatchObject({
      method: 'DELETE',
      url: 'https://graph.facebook.com/v18.0/c1?access_token=tok',
    });
  });

  it('sends a private reply with POST /{page-id}/messages and a comment_id recipient', async () => {
    net = mockFetch(() => json({ recipient_id: 'psid-9', message_id: 'm-1' }));
    const out = await adapter.sendPrivateReply(
      channel('facebook'),
      'c1',
      'thanks!',
    );
    expect(net.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://graph.facebook.com/v18.0/acct-1/messages?access_token=tok',
      body: { recipient: { comment_id: 'c1' }, message: { text: 'thanks!' } },
    });
    expect(out).toMatchObject({
      recipientPlatformId: 'psid-9',
      platformItemId: 'm-1',
    });
    expect(out.platformCreatedAt).toBeInstanceOf(Date);
  });

  it('a private reply accepted without a message id still succeeds (id null)', async () => {
    net = mockFetch(() => json({ recipient_id: 'psid-9' }));
    const out = await adapter.sendPrivateReply(
      channel('facebook'),
      'c1',
      'thanks!',
    );
    expect(out.platformItemId).toBeNull();
    expect(out.recipientPlatformId).toBe('psid-9');
  });

  it('a private reply accepted without a recipient is a non-retryable PLATFORM_ERROR', async () => {
    net = mockFetch(() => json({ message_id: 'm-1' }));
    const err: unknown = await adapter
      .sendPrivateReply(channel('facebook'), 'c1', 'x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InboxSendError);
    expect((err as InboxSendError).getResponse()).toMatchObject({
      code: 'PLATFORM_ERROR',
      retryable: false,
    });
  });

  it('surfaces a platform refusal', async () => {
    net = mockFetch(() => json({ error: { message: '(#10) no' } }, 400));
    await expect(
      adapter.likeComment(channel('facebook'), { platformItemId: 'c1' }, true),
    ).rejects.toThrow(/Facebook like failed: 400/);
  });
});

describe('InstagramInboxAdapter comment actions', () => {
  const adapter = new InstagramInboxAdapter(new InstagramService());
  let net: ReturnType<typeof mockFetch>;
  afterEach(() => net.restore());

  it('hides with POST /{ig-comment-id} hide=true', async () => {
    net = mockFetch();
    await adapter.hideComment(channel('instagram'), 'ig-c1', true);
    expect(net.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://graph.instagram.com/ig-c1?access_token=tok&hide=true',
    });
  });

  it('unhides with hide=false', async () => {
    net = mockFetch();
    await adapter.hideComment(channel('instagram'), 'ig-c1', false);
    expect(net.requests[0].url).toContain('hide=false');
  });

  it("deletes someone else's comment with DELETE /{ig-comment-id}", async () => {
    net = mockFetch();
    await adapter.moderateDelete(channel('instagram'), 'ig-c1');
    expect(net.requests[0]).toMatchObject({
      method: 'DELETE',
      url: 'https://graph.instagram.com/ig-c1?access_token=tok',
    });
  });

  it('sends a private reply with POST /{ig-user-id}/messages', async () => {
    net = mockFetch(() => json({ recipient_id: 'igsid-3', message_id: 'm-2' }));
    const out = await adapter.sendPrivateReply(
      channel('instagram'),
      'ig-c1',
      'hello',
    );
    expect(net.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://graph.instagram.com/acct-1/messages?access_token=tok',
      body: { recipient: { comment_id: 'ig-c1' }, message: { text: 'hello' } },
    });
    expect(out).toMatchObject({
      recipientPlatformId: 'igsid-3',
      platformItemId: 'm-2',
    });
  });

  it('has no like: the capability matrix keeps it out of reach', () => {
    expect('likeComment' in adapter).toBe(false);
  });
});
