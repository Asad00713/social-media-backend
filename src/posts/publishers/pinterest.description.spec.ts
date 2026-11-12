import { Test } from '@nestjs/testing';
import {
  PINTEREST_MAX_DESCRIPTION,
  PinterestPublisher,
  pickDescription,
} from './pinterest.publisher';
import { PinterestService } from '../../channels/services/pinterest.service';

/**
 * P1: the Pin's description is the Pin card's Description field - what the
 * card shows - and nothing else. An empty one used to fall back to the
 * shared caption, which the Pin card never showed and never counted
 * against Pinterest's 800.
 */
describe('PinterestPublisher - description sent', () => {
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

  const options = (metadata: Record<string, unknown>, content: string) =>
    ({
      content,
      mediaItems: [{ type: 'image', url: 'https://x/a.jpg' }],
      accessToken: 'token',
      platformAccountId: 'acct',
      channelMetadata: {},
      channelId: 1,
      metadata: { boardId: 'board-1', title: 'Title', ...metadata },
    }) as any;

  /** createPin(token, board, title, description, url, opts) */
  const sentDescription = () => createPin.mock.calls[0][3];

  it('sends the typed description', async () => {
    await publisher.publish(
      options({ description: 'For the Pin' }, 'Shared caption'),
    );
    expect(sentDescription()).toBe('For the Pin');
  });

  it('an empty description stays empty - the shared caption is not sent', async () => {
    await publisher.publish(options({}, 'Shared caption'));
    expect(sentDescription()).toBe('');
  });

  it('refuses a description over 800 rather than cutting it', async () => {
    const tooLong = 'x'.repeat(PINTEREST_MAX_DESCRIPTION + 1);
    await expect(
      publisher.publish(options({ description: tooLong }, '')),
    ).rejects.toThrow(/800/);
    expect(createPin).not.toHaveBeenCalled();
  });

  it('a long shared caption is not the Pin text and blocks nothing', async () => {
    await publisher.publish(options({ description: 'ok' }, 'y'.repeat(5000)));
    expect(sentDescription()).toBe('ok');
  });

  it('accepts exactly 800', async () => {
    const max = 'x'.repeat(PINTEREST_MAX_DESCRIPTION);
    await publisher.publish(options({ description: max }, ''));
    expect(sentDescription()).toBe(max);
  });

  it('pickDescription reads only metadata.description', () => {
    expect(pickDescription(undefined)).toBe('');
    expect(pickDescription({ description: 3 })).toBe('');
    expect(pickDescription({ description: 'a' })).toBe('a');
  });
});
