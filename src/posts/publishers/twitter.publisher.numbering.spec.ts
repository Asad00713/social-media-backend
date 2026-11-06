import { Test } from '@nestjs/testing';
import { TwitterPublisher, numberedThreadTexts } from './twitter.publisher';
import { TwitterService } from '../../channels/services/twitter.service';

/**
 * "Number posts" (#58): ` n/N` after each post of a thread, counted inside
 * the 280. The composer's `x-thread-numbering.test.ts` pins the same
 * examples — the two must agree, or the counter and this validate() would
 * disagree about the same post.
 */
describe('TwitterPublisher — numbering a thread', () => {
  let publisher: TwitterPublisher;
  let createTweet: jest.Mock;
  let n = 0;

  beforeEach(async () => {
    n = 0;
    createTweet = jest.fn(() => Promise.resolve({ id: `t${++n}`, text: '' }));
    const moduleRef = await Test.createTestingModule({
      providers: [
        TwitterPublisher,
        {
          provide: TwitterService,
          useValue: { createTweet, uploadMedia: jest.fn() },
        },
      ],
    }).compile();
    publisher = moduleRef.get(TwitterPublisher);
  });

  const options = (thread: { text: string }[], numberPosts?: boolean) => ({
    content: thread[0].text,
    mediaItems: [],
    accessToken: 'token',
    platformAccountId: 'acct',
    channelMetadata: {},
    channelId: 1,
    metadata: { thread, numberPosts },
  });

  const sentTexts = () => createTweet.mock.calls.map((c) => c[1] as string);

  it('appends " n/N" to every post when on', async () => {
    await publisher.publish(
      options([{ text: 'One' }, { text: 'Two' }, { text: 'Three' }], true),
    );

    expect(sentTexts()).toEqual(['One 1/3', 'Two 2/3', 'Three 3/3']);
  });

  it('sends the texts untouched when off', async () => {
    await publisher.publish(options([{ text: 'One' }, { text: 'Two' }]));

    expect(sentTexts()).toEqual(['One', 'Two']);
  });

  it('only numbers for an explicit true', async () => {
    await publisher.publish(
      options([{ text: 'One' }, { text: 'Two' }], 'yes' as unknown as boolean),
    );

    expect(sentTexts()).toEqual(['One', 'Two']);
  });

  it('counts the number inside the 280', () => {
    // 277 + " 1/2" = 281.
    const thread = [{ text: 'x'.repeat(277) }, { text: 'two' }];

    expect(() => publisher.validate(options(thread, true))).toThrow(
      'Thread tweet 1 exceeds 280 character limit (281 chars, with its number)',
    );
    expect(() => publisher.validate(options(thread, false))).not.toThrow();
  });

  it('lets exactly 280 through with the number', () => {
    const thread = [{ text: 'x'.repeat(276) }, { text: 'two' }];

    expect(() => publisher.validate(options(thread, true))).not.toThrow();
  });

  it('refuses before posting anything', async () => {
    const thread = [{ text: 'one' }, { text: 'x'.repeat(277) }];

    await expect(publisher.publish(options(thread, true))).rejects.toThrow(
      'Thread tweet 2 exceeds',
    );
    expect(createTweet).not.toHaveBeenCalled();
  });

  it('numbers a media-only post without a leading space', () => {
    expect(numberedThreadTexts(['Hi', ''], true)).toEqual(['Hi 1/2', '2/2']);
  });
});
