import { Test } from '@nestjs/testing';
import { MastodonPublisher } from './mastodon.publisher';
import { MastodonService } from '../../channels/services/mastodon.service';

/**
 * What the publisher hands the service for the composer's "Allow quotes"
 * row. The composer's draft key is `allowQuotes` (it already was, before
 * anything read it), and `platformSpecific` reaches the publisher verbatim,
 * so that is the key this reads.
 */
describe('MastodonPublisher — allow quotes', () => {
  let publisher: MastodonPublisher;
  let createStatus: jest.Mock;

  beforeEach(async () => {
    createStatus = jest
      .fn()
      .mockResolvedValue({ id: 's1', url: 'https://m.test/s1' });

    const moduleRef = await Test.createTestingModule({
      providers: [
        MastodonPublisher,
        {
          provide: MastodonService,
          useValue: { createStatus, uploadMedia: jest.fn() },
        },
      ],
    }).compile();

    publisher = moduleRef.get(MastodonPublisher);
  });

  const options = (metadata: Record<string, any>) => ({
    content: 'hello',
    mediaItems: [],
    accessToken: 'token',
    platformAccountId: 'acct',
    channelMetadata: { instanceUrl: 'm.test' },
    channelId: 1,
    metadata,
  });

  /** The options object handed to createStatus for the first post. */
  const passed = () => createStatus.mock.calls[0][3];

  it.each(['public', 'followers', 'nobody'])(
    'forwards %s as the quote policy',
    async (policy) => {
      await publisher.publish(options({ allowQuotes: policy }));

      expect(passed().quoteApprovalPolicy).toBe(policy);
    },
  );

  it('forwards nothing when the row was never touched', async () => {
    await publisher.publish(options({}));

    expect(passed().quoteApprovalPolicy).toBeUndefined();
  });

  it.each([
    ['an unknown word', 'friends'],
    ['a boolean', true],
    ['a number', 1],
    ['an empty string', ''],
    ['the wrong case', 'Nobody'],
  ])('forwards nothing for %s', async (_label, value) => {
    await publisher.publish(options({ allowQuotes: value }));

    expect(passed().quoteApprovalPolicy).toBeUndefined();
  });

  it('does not read the API field name as the draft key', async () => {
    // A draft key spelled like the API field is NOT what the composer
    // writes; reading both would hide a key mismatch rather than fix it.
    await publisher.publish(options({ quote_approval_policy: 'nobody' }));

    expect(passed().quoteApprovalPolicy).toBeUndefined();
  });

  it('keeps the language and visibility it already forwarded', async () => {
    await publisher.publish(
      options({ allowQuotes: 'nobody', language: 'ur', visibility: 'unlisted' }),
    );

    expect(passed()).toMatchObject({
      quoteApprovalPolicy: 'nobody',
      language: 'ur',
      visibility: 'unlisted',
    });
  });

  // The composer drops the row in a thread, so a value left over from
  // before the switch is a setting nobody can see. It is not sent.
  it('does not send a leftover policy on the posts of a thread', async () => {
    await publisher.publish(
      options({
        allowQuotes: 'nobody',
        thread: [{ text: 'one' }, { text: 'two' }],
      }),
    );

    expect(createStatus).toHaveBeenCalledTimes(2);
    for (const call of createStatus.mock.calls) {
      expect(call[3].quoteApprovalPolicy).toBeUndefined();
    }
  });
});
