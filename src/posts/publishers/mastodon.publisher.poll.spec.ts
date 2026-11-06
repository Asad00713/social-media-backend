import { Test } from '@nestjs/testing';
import { MastodonPublisher } from './mastodon.publisher';
import { MastodonService } from '../../channels/services/mastodon.service';

/**
 * What the publisher hands the service: the poll, and the language the
 * service already supported and nothing passed.
 */
describe('MastodonPublisher — poll and language', () => {
  let publisher: MastodonPublisher;
  let createStatus: jest.Mock;

  beforeEach(async () => {
    createStatus = jest
      .fn()
      .mockResolvedValue({ id: 'status-1', url: 'https://m.test/1' });

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
    content: 'Iced Spanish latte is back',
    mediaItems: [],
    accessToken: 'token',
    platformAccountId: 'acct',
    channelMetadata: { instanceUrl: 'https://mastodon.test' },
    channelId: 1,
    metadata,
  });

  /** The options object handed to createStatus. */
  const passed = () => createStatus.mock.calls[0][3];

  it('forwards the poll', async () => {
    await publisher.publish(
      options({
        poll: {
          options: ['one', 'two'],
          expiresInSeconds: 86400,
          multiple: true,
        },
      }),
    );

    expect(passed().poll).toEqual({
      options: ['one', 'two'],
      expiresInSeconds: 86400,
      multiple: true,
    });
  });

  // Mastodon rejects the whole status for a malformed poll, so one that
  // cannot be sent is dropped and the post survives.
  it.each([
    ['there is no poll', {}],
    ['it has one answer', { poll: { options: ['only'], expiresInSeconds: 60 } }],
    ['the answers are blank', { poll: { options: ['  ', ''], expiresInSeconds: 60 } }],
    ['the duration is missing', { poll: { options: ['one', 'two'] } }],
    ['the duration is zero', { poll: { options: ['one', 'two'], expiresInSeconds: 0 } }],
    ['options is not a list', { poll: { options: 'one,two', expiresInSeconds: 60 } }],
  ])('sends no poll when %s', async (_label, metadata) => {
    await publisher.publish(options(metadata));

    expect(passed().poll).toBeUndefined();
  });

  it('defaults multiple to false', async () => {
    await publisher.publish(
      options({ poll: { options: ['one', 'two'], expiresInSeconds: 60 } }),
    );

    expect(passed().poll.multiple).toBe(false);
  });

  // The service has always accepted this; nothing passed it.
  it('forwards the language, trimmed', async () => {
    await publisher.publish(options({ language: '  ur  ' }));

    expect(passed().language).toBe('ur');
  });

  it.each([
    ['nothing was chosen', {}],
    ['it is blank', { language: '   ' }],
  ])('sends no language when %s', async (_label, metadata) => {
    await publisher.publish(options(metadata));

    expect(passed().language).toBeUndefined();
  });
});
