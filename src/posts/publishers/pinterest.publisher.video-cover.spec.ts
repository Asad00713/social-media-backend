import { Test } from '@nestjs/testing';
import { PinterestPublisher } from './pinterest.publisher';
import { PinterestService } from '../../channels/services/pinterest.service';

/**
 * The composer's video cover reaching the service: the uploaded frame as
 * `videoCoverImageUrl`, and the same choice as a second in
 * `coverFrameSec`. The service spec covers the request body.
 */
describe('PinterestPublisher — video cover', () => {
  let publisher: PinterestPublisher;
  let createPin: jest.Mock;

  beforeEach(async () => {
    createPin = jest.fn().mockResolvedValue({ pinId: 'pin-1' });

    const moduleRef = await Test.createTestingModule({
      providers: [
        PinterestPublisher,
        { provide: PinterestService, useValue: { createPin } },
      ],
    }).compile();

    publisher = moduleRef.get(PinterestPublisher);
  });

  const publish = (metadata: Record<string, any>) =>
    publisher.publish({
      content: 'body',
      mediaItems: [{ type: 'video', url: 'https://cdn.test/clip.mp4' }],
      accessToken: 'token',
      platformAccountId: 'acct',
      channelMetadata: {},
      channelId: 1,
      metadata: { boardId: 'board-1', title: 'Title', ...metadata },
    } as any);

  /** The options object handed to createPin. */
  const passed = () => createPin.mock.calls[0][5];

  it('passes the uploaded frame and the stored second', async () => {
    await publish({
      videoCoverImageUrl: ' https://cdn.test/frame.jpg ',
      coverFrameSec: 3,
    });

    expect(passed().videoCoverImageUrl).toBe('https://cdn.test/frame.jpg');
    expect(passed().coverKeyFrameSec).toBe(3);
  });

  it.each([
    ['blank', '   '],
    ['not a string', 42],
  ])('drops a cover URL that is %s', async (_label, url) => {
    await publish({ videoCoverImageUrl: url });

    expect(passed().videoCoverImageUrl).toBeUndefined();
  });

  it('drops a second that is not a number', async () => {
    await publish({ coverFrameSec: '3' });

    expect(passed().coverKeyFrameSec).toBeUndefined();
  });
});
