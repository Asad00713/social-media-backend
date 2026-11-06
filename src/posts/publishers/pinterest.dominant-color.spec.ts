import { PinterestPublisher, pickDominantColor } from './pinterest.publisher';
import { PinterestService } from '../../channels/services/pinterest.service';

/**
 * The composer's Pinterest "More settings" sets `dominantColor`, sent as
 * `dominant_color` on the create call. The service tests pin the body key on
 * both the image and the video create; the publisher tests pin the draft key
 * and the hex shape.
 */
describe('Pinterest dominant colour', () => {
  describe('pickDominantColor', () => {
    it('sends a six-digit hex in Pinterest’s own shape', () => {
      expect(pickDominantColor({ dominantColor: '#6e7874' })).toBe('#6E7874');
      expect(pickDominantColor({ dominantColor: '6E7874' })).toBe('#6E7874');
    });

    it('sends nothing for anything else', () => {
      for (const value of ['', '#fff', 'red', '#6E78744', 42, null]) {
        expect(pickDominantColor({ dominantColor: value })).toBeUndefined();
      }
      expect(pickDominantColor(undefined)).toBeUndefined();
    });
  });

  describe('PinterestService.createPin', () => {
    let service: PinterestService;
    let fetchMock: jest.Mock;

    beforeEach(() => {
      service = new PinterestService();
      fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'pin-1' }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;
    });

    const body = (call = 0) =>
      JSON.parse(fetchMock.mock.calls[call][1].body as string);

    it('puts dominant_color on the image pin body', async () => {
      await service.createPin('t', 'b', 'T', 'D', 'https://x.test/a.jpg', {
        dominantColor: '#6E7874',
      });
      expect(body().dominant_color).toBe('#6E7874');
    });

    it('leaves it out when none is chosen', async () => {
      await service.createPin('t', 'b', 'T', 'D', 'https://x.test/a.jpg', {});
      expect('dominant_color' in body()).toBe(false);
    });

    it('puts dominant_color on the video pin body too', async () => {
      // register -> S3 upload -> (processing poll) -> create
      fetchMock.mockReset();
      fetchMock.mockImplementation(async (url: string) => {
        if (url.endsWith('/media')) {
          return {
            ok: true,
            json: async () => ({
              media_id: 'm1',
              upload_url: 'https://s3.test',
            }),
          };
        }
        if (url.includes('/media/m1')) {
          return { ok: true, json: async () => ({ status: 'succeeded' }) };
        }
        if (url.endsWith('/pins')) {
          return { ok: true, json: async () => ({ id: 'pin-v' }) };
        }
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
      });
      await service.createPin('t', 'b', 'T', 'D', 'https://x.test/v.mp4', {
        mediaType: 'video',
        dominantColor: '#123456',
      });
      const create = fetchMock.mock.calls.find(([u]) =>
        String(u).endsWith('/pins'),
      );
      expect(JSON.parse(create![1].body as string).dominant_color).toBe(
        '#123456',
      );
    });
  });

  describe('PinterestPublisher', () => {
    it('reads the draft’s own key and forwards it', async () => {
      const createPin = jest.fn().mockResolvedValue({ pinId: 'pin-1' });
      const publisher = new PinterestPublisher({
        createPin,
      } as unknown as PinterestService);
      await publisher.publish({
        content: 'body',
        mediaItems: [{ type: 'image', url: 'https://x.test/a.jpg' } as any],
        accessToken: 't',
        platformAccountId: 'a',
        channelMetadata: {},
        channelId: 1,
        metadata: { boardId: 'b', title: 'T', dominantColor: '#aabbcc' },
      });
      expect(createPin.mock.calls[0][5].dominantColor).toBe('#AABBCC');
    });
  });
});
