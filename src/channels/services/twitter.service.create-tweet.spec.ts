import { ConfigService } from '@nestjs/config';
import { TwitterService } from './twitter.service';

/**
 * These assert the HTTP BODY, not the options object.
 *
 * The publisher's tests pass camelCase options straight through, so they
 * stay green even if a body key is misspelled — and X sets
 * `additionalProperties: false` on the request, which turns a misspelled
 * key into a rejected post rather than an ignored field. The snake_case
 * mapping is therefore the thing worth pinning down, and only this layer
 * can see it.
 */
describe('TwitterService.createTweet — the request body', () => {
  let service: TwitterService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    service = new TwitterService({
      get: () => undefined,
    } as unknown as ConfigService);

    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { id: '1', text: 'hi', created_at: '2026-10-31T00:00:00Z' },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const bodySentFor = async (
    options?: Parameters<TwitterService['createTweet']>[2],
  ) => {
    await service.createTweet('token', 'Iced Spanish latte is back', options);
    const [, init] = fetchMock.mock.calls[0];
    return JSON.parse(init.body as string);
  };

  it('names the disclosures as X spells them', async () => {
    const body = await bodySentFor({
      madeWithAi: true,
      paidPartnership: true,
    });

    expect(body.made_with_ai).toBe(true);
    expect(body.paid_partnership).toBe(true);
  });

  it('names the reply setting as X spells it', async () => {
    const body = await bodySentFor({ replySettings: 'mentionedUsers' });

    expect(body.reply_settings).toBe('mentionedUsers');
  });

  // `additionalProperties: false` means an unexpected key fails the post,
  // and a `false` disclosure says nothing an absent one does not.
  it('sends no disclosure keys when neither was set', async () => {
    const body = await bodySentFor({});

    expect('made_with_ai' in body).toBe(false);
    expect('paid_partnership' in body).toBe(false);
    expect('reply_settings' in body).toBe(false);
  });

  it('sends no disclosure key for a false disclosure', async () => {
    const body = await bodySentFor({
      madeWithAi: false,
      paidPartnership: false,
    });

    expect('made_with_ai' in body).toBe(false);
    expect('paid_partnership' in body).toBe(false);
  });

  it('sends only the disclosure that was set', async () => {
    const body = await bodySentFor({ paidPartnership: true });

    expect(body.paid_partnership).toBe(true);
    expect('made_with_ai' in body).toBe(false);
  });
});
