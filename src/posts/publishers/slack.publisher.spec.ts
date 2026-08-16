import { SlackPublisher } from './slack.publisher';
import type { PublishOptions } from './base.publisher';

function baseOptions(over: Partial<PublishOptions> = {}): PublishOptions {
  return {
    content: 'hello team',
    mediaItems: [],
    metadata: { destination: { id: 'C123', name: '#general' } },
    accessToken: 'xoxb-token',
    platformAccountId: 'T1',
    channelMetadata: {},
    channelId: 7,
    ...over,
  };
}

describe('SlackPublisher', () => {
  function make() {
    const postMessage = jest.fn().mockResolvedValue({ ts: '1700000000.0001', channel: 'C123' });
    const uploadFile = jest.fn().mockResolvedValue({ fileId: 'F0123ABC' });
    const slackService = { postMessage, uploadFile } as never;
    return { publisher: new SlackPublisher(slackService), postMessage, uploadFile };
  }

  it('rejects a missing destination', () => {
    const { publisher } = make();
    expect(() => publisher.validate(baseOptions({ metadata: {} }))).toThrow(/destination/i);
  });

  it('rejects more than one media item', () => {
    const { publisher } = make();
    const media = [
      { url: 'a', type: 'image' as const },
      { url: 'b', type: 'image' as const },
    ];
    expect(() => publisher.validate(baseOptions({ mediaItems: media }))).toThrow(/one media/i);
  });

  it('rejects empty message with no media', () => {
    const { publisher } = make();
    expect(() => publisher.validate(baseOptions({ content: '', mediaItems: [] }))).toThrow(/message or media/i);
  });

  it('posts a text-only message to the destination channel', async () => {
    const { publisher, postMessage, uploadFile } = make();
    const res = await publisher.publish(baseOptions());
    expect(postMessage).toHaveBeenCalledWith('xoxb-token', { channel: 'C123', text: 'hello team' });
    expect(uploadFile).not.toHaveBeenCalled();
    expect(res.platformPostId).toBe('1700000000.0001');
  });
});
