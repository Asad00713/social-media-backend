import { Test } from '@nestjs/testing';
import { MastodonPublisher } from './mastodon.publisher';
import { MastodonService } from '../../channels/services/mastodon.service';

/**
 * The composer's `quotePostUrl` reaching `quoted_status_id` — and, more
 * importantly, NOT reaching an older server, which would publish the text
 * without its quote.
 */
describe('MastodonPublisher — quote a post', () => {
  let publisher: MastodonPublisher;
  let service: Record<string, jest.Mock>;
  const LINK = 'https://other.social/@ann/1234';
  let n = 0;

  beforeEach(async () => {
    n = 0;
    service = {
      createStatus: jest.fn(() =>
        Promise.resolve({ id: `s${++n}`, url: `https://m.test/s${n}` }),
      ),
      uploadMedia: jest.fn().mockResolvedValue({ id: 'm1' }),
      getApiVersion: jest.fn().mockResolvedValue(7),
      resolveStatusUrl: jest.fn().mockResolvedValue('9001'),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MastodonPublisher,
        { provide: MastodonService, useValue: service },
      ],
    }).compile();
    publisher = moduleRef.get(MastodonPublisher);
  });

  const options = (
    metadata: Record<string, any>,
    extra: Record<string, any> = {},
  ) => ({
    content: 'Read this',
    mediaItems: [],
    accessToken: 'token',
    platformAccountId: 'acct',
    channelMetadata: { instanceUrl: 'm.test' },
    channelId: 1,
    metadata,
    ...extra,
  });

  const passed = (i = 0) => service.createStatus.mock.calls[i][3];

  it('resolves the link on the user’s server and sends its id', async () => {
    await publisher.publish(options({ quotePostUrl: LINK }));

    expect(service.resolveStatusUrl).toHaveBeenCalledWith(
      'm.test',
      'token',
      LINK,
    );
    expect(passed().quotedStatusId).toBe('9001');
  });

  it('accepts API version 7 exactly', async () => {
    service.getApiVersion.mockResolvedValue(7);

    await expect(
      publisher.publish(options({ quotePostUrl: LINK })),
    ).resolves.toBeDefined();
  });

  it('refuses a server older than 4.5 before posting anything', async () => {
    service.getApiVersion.mockResolvedValue(6);

    await expect(
      publisher.publish(
        options(
          { quotePostUrl: LINK },
          { mediaItems: [{ type: 'image', url: 'https://cdn/a.jpg' }] },
        ),
      ),
    ).rejects.toThrow('needs Mastodon 4.5 or later');
    expect(service.resolveStatusUrl).not.toHaveBeenCalled();
    expect(service.uploadMedia).not.toHaveBeenCalled();
    expect(service.createStatus).not.toHaveBeenCalled();
  });

  it('posts nothing when the link cannot be resolved', async () => {
    service.resolveStatusUrl.mockRejectedValue(new Error('not found'));

    await expect(
      publisher.publish(options({ quotePostUrl: LINK })),
    ).rejects.toThrow('not found');
    expect(service.createStatus).not.toHaveBeenCalled();
  });

  it('asks nothing of the server without a quote', async () => {
    await publisher.publish(options({ quotePostUrl: '  ' }));

    expect(service.getApiVersion).not.toHaveBeenCalled();
    expect(passed().quotedStatusId).toBeUndefined();
  });

  it('refuses a link that is not https in validate()', () => {
    expect(() =>
      publisher.validate(options({ quotePostUrl: 'other.social/@ann/1' })),
    ).toThrow('is not a link to a post');
    expect(() =>
      publisher.validate(options({ quotePostUrl: 'http://other.social/@a/1' })),
    ).toThrow('is not a link to a post');
    expect(() =>
      publisher.validate(options({ quotePostUrl: LINK })),
    ).not.toThrow();
  });

  it('quotes from post 1 of a thread only', async () => {
    await publisher.publish(
      options({
        quotePostUrl: LINK,
        thread: [{ text: 'one' }, { text: 'two' }, { text: 'three' }],
      }),
    );

    expect(passed(0).quotedStatusId).toBe('9001');
    expect(passed(1).quotedStatusId).toBeUndefined();
    expect(passed(2).quotedStatusId).toBeUndefined();
  });
});
