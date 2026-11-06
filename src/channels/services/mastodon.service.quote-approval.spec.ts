import { ConfigService } from '@nestjs/config';
import { MastodonService } from './mastodon.service';

/**
 * `quote_approval_policy` on the status create.
 *
 * Mastodon 4.5 added it (API version 7): `public`, `followers` or `nobody`,
 * and "when omitted, the user's default setting will be used instead". That
 * second sentence is why this pins the body from both sides — a policy that
 * is sent when it should not be would override an account preference.
 */
describe('MastodonService.createStatus — quote approval', () => {
  let service: MastodonService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    service = new MastodonService({ get: jest.fn() } as unknown as ConfigService);
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: '1', uri: 'u', url: 'https://m.test/1' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const bodyFor = async (
    options?: Parameters<MastodonService['createStatus']>[3],
  ) => {
    await service.createStatus('m.test', 'token', 'hello', options);
    return JSON.parse(fetchMock.mock.calls[0][1].body as string);
  };

  it.each(['public', 'followers', 'nobody'] as const)(
    'names %s as quote_approval_policy',
    async (policy) => {
      const body = await bodyFor({ quoteApprovalPolicy: policy });

      expect(body.quote_approval_policy).toBe(policy);
    },
  );

  it('posts to the status endpoint of the instance', async () => {
    await bodyFor({ quoteApprovalPolicy: 'nobody' });

    expect(fetchMock.mock.calls[0][0]).toBe('https://m.test/api/v1/statuses');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  // The account's own default applies when the key is absent. Sending
  // `public` by default would override someone who chose `nobody`.
  it('leaves the key out when no policy is chosen', async () => {
    const body = await bodyFor({ visibility: 'public' });

    expect('quote_approval_policy' in body).toBe(false);
  });

  it('leaves the key out with no options at all', async () => {
    const body = await bodyFor();

    expect('quote_approval_policy' in body).toBe(false);
  });

  it('is a top-level field of the body, beside the status text', async () => {
    const body = await bodyFor({ quoteApprovalPolicy: 'followers' });

    expect(body).toEqual({
      status: 'hello',
      quote_approval_policy: 'followers',
    });
  });

  it('does not disturb the other fields it travels with', async () => {
    const body = await bodyFor({
      quoteApprovalPolicy: 'nobody',
      visibility: 'unlisted',
      language: 'ur',
      sensitive: true,
    });

    expect(body).toMatchObject({
      quote_approval_policy: 'nobody',
      visibility: 'unlisted',
      language: 'ur',
      sensitive: true,
    });
  });
});
