import { TikTokService } from './tiktok.service';

/**
 * The AI-generated flag sits in a DIFFERENT place on each of TikTok's two
 * publish endpoints, and a wrong placement fails quietly — TikTok either
 * ignores the key or rejects the whole post. So these tests pin the request
 * body, which is the only thing that can be wrong; the publisher spec only
 * proves the value reaches this method.
 */
describe('TikTokService AI-generated flag', () => {
  let service: TikTokService;
  let fetchMock: jest.Mock;

  const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

  beforeEach(() => {
    service = new TikTokService();
    fetchMock = jest.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ data: { publish_id: 'p1' }, error: { code: 'ok' } }),
      json: async () => ({ data: { publish_id: 'p1' }, error: { code: 'ok' } }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  describe('video (Direct Post)', () => {
    const post = (isAigc?: boolean) =>
      service.postVideoFromUrl('tok', 'https://x/v.mp4', {
        title: 'hi',
        privacyLevel: 'PUBLIC_TO_EVERYONE',
        isAigc,
      });

    it('declares is_aigc inside post_info', async () => {
      await post(true);
      const body = sentBody();
      expect(body.post_info.is_aigc).toBe(true);
      expect(body.is_aigc).toBeUndefined();
    });

    it('omits the key when not declared, rather than sending false', async () => {
      await post(undefined);
      expect('is_aigc' in sentBody().post_info).toBe(false);
      await post(false);
      expect(
        'is_aigc' in JSON.parse(fetchMock.mock.calls[1][1].body).post_info,
      ).toBe(false);
    });
  });

  describe('photo carousel', () => {
    const post = (isAigc?: boolean) =>
      service.postPhotoFromUrl('tok', ['https://x/a.jpg'], {
        privacyLevel: 'PUBLIC_TO_EVERYONE',
        isAigc,
      });

    it('declares is_aigc at the top level of the body, not in post_info', async () => {
      await post(true);
      const body = sentBody();
      expect(body.is_aigc).toBe(true);
      expect(body.post_info.is_aigc).toBeUndefined();
    });

    it('omits the key when not declared', async () => {
      await post(undefined);
      expect('is_aigc' in sentBody()).toBe(false);
    });
  });
});
