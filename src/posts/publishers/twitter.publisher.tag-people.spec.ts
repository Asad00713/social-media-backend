import { Test } from '@nestjs/testing';
import { TwitterPublisher } from './twitter.publisher';
import { TwitterService } from '../../channels/services/twitter.service';

// These tests stub the network with `global.fetch`. The media download goes
// through the SSRF-guarded fetchPublicMedia (undici + a pinned-DNS agent), so
// route it back to the stub; the guard itself is covered in public-fetch.spec.
jest.mock('../../common/net/public-fetch', () => ({
  ...jest.requireActual<typeof import('../../common/net/public-fetch')>(
    '../../common/net/public-fetch',
  ),
  fetchPublicMedia: (url: string) => global.fetch(url),
}));

/**
 * "Tag people" (`tagPeople`, the publisher's own key) -> usernames looked
 * up, then `media.tagged_user_ids` on the post's photos.
 */
describe('TwitterPublisher — tag people', () => {
  let publisher: TwitterPublisher;
  let service: Record<string, jest.Mock>;
  const realFetch = global.fetch;

  beforeEach(async () => {
    // The publisher downloads each media URL before uploading it.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    }) as unknown as typeof fetch;
    service = {
      createTweet: jest.fn().mockResolvedValue({ id: 't1', text: '' }),
      uploadMedia: jest.fn().mockResolvedValue('m1'),
      lookupUserIds: jest.fn().mockResolvedValue(
        new Map([
          ['ann_b', '111'],
          ['bob', '222'],
        ]),
      ),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        TwitterPublisher,
        { provide: TwitterService, useValue: service },
      ],
    }).compile();
    publisher = moduleRef.get(TwitterPublisher);
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  const PHOTO = { type: 'image', url: 'https://cdn/a.jpg' };
  const options = (
    metadata: Record<string, any>,
    mediaItems: any[] = [PHOTO],
  ) => ({
    content: 'Team photo',
    mediaItems,
    accessToken: 'token',
    platformAccountId: 'acct',
    channelMetadata: {},
    channelId: 1,
    metadata,
  });

  const passed = () => service.createTweet.mock.calls[0][2];

  it('looks the usernames up and sends their ids, in order', async () => {
    await publisher.publish(options({ tagPeople: ['Ann_B', '@bob'] }));

    expect(service.lookupUserIds).toHaveBeenCalledWith('token', [
      'Ann_B',
      'bob',
    ]);
    expect(passed().taggedUserIds).toEqual(['111', '222']);
  });

  it('fails before uploading when X does not know a username', async () => {
    await expect(
      publisher.publish(options({ tagPeople: ['ann_b', 'ghost'] })),
    ).rejects.toThrow('X has no account @ghost to tag');
    expect(service.uploadMedia).not.toHaveBeenCalled();
    expect(service.createTweet).not.toHaveBeenCalled();
  });

  it('tags nobody, and looks nobody up, without a photo', async () => {
    await publisher.publish(
      options({ tagPeople: ['ann_b'] }, [
        { type: 'video', url: 'https://cdn/v.mp4' },
      ]),
    );

    expect(service.lookupUserIds).not.toHaveBeenCalled();
    expect(passed().taggedUserIds).toBeUndefined();
  });

  it('sends nothing when nobody is tagged', async () => {
    await publisher.publish(options({}));

    expect(service.lookupUserIds).not.toHaveBeenCalled();
    expect(passed().taggedUserIds).toBeUndefined();
  });

  it('refuses a username X would not accept', () => {
    expect(() =>
      publisher.validate(options({ tagPeople: ['not-ok'] })),
    ).toThrow('"@not-ok" is not an X username');
  });

  it('refuses more than 10 and accepts 10', () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);
    expect(() => publisher.validate(options({ tagPeople: names(11) }))).toThrow(
      'at most 10 tagged people',
    );
    expect(() =>
      publisher.validate(options({ tagPeople: names(10) })),
    ).not.toThrow();
  });
});
