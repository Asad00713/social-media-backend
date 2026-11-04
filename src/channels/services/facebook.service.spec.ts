import { FacebookService } from './facebook.service';

/**
 * A Reel is published in three calls, and where a setting goes decides
 * whether it works: Graph either ignores a misplaced key or rejects the whole
 * Reel, and neither shows up until publish. So these tests pin the REQUEST of
 * each call, which is the only thing that can be wrong; the publisher spec
 * only proves the value reaches this method.
 */
describe('FacebookService.postReelToPage', () => {
  let service: FacebookService;
  let fetchMock: jest.Mock;

  const START = 0;
  const UPLOAD = 1;
  const FINISH = 2;

  const urlOf = (call: number) =>
    new URL(String(fetchMock.mock.calls[call][0]));

  beforeEach(() => {
    service = new FacebookService();
    fetchMock = jest.fn().mockImplementation(async (input: unknown) => {
      const url = String(input);
      const body = url.includes('upload_phase=start')
        ? { video_id: 'vid-1', upload_url: 'https://rupload.example/vid-1' }
        : { success: true };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const post = (
    options?: Parameters<FacebookService['postReelToPage']>[4],
    description = 'a caption',
  ) =>
    service.postReelToPage(
      'page-1',
      'page-token',
      'https://cdn.example/v.mp4',
      description,
      options,
    );

  describe('title', () => {
    it('is sent on the FINISH call, beside the description', async () => {
      await post({ title: 'Iced Spanish latte' });

      const finish = urlOf(FINISH);
      expect(finish.pathname).toMatch(/\/page-1\/video_reels$/);
      expect(finish.searchParams.get('upload_phase')).toBe('finish');
      expect(finish.searchParams.get('title')).toBe('Iced Spanish latte');
      expect(finish.searchParams.get('description')).toBe('a caption');
    });

    it('is NOT sent on the start call, which takes only the phase', async () => {
      await post({ title: 'Iced Spanish latte' });

      expect(urlOf(START).searchParams.get('upload_phase')).toBe('start');
      expect(urlOf(START).searchParams.has('title')).toBe(false);
    });

    it('is not smuggled into the transfer headers either', async () => {
      await post({ title: 'Iced Spanish latte' });

      const headers = fetchMock.mock.calls[UPLOAD][1].headers as Record<
        string,
        string
      >;
      expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain(
        'title',
      );
    });

    it('is left out when there is none, rather than sent empty', async () => {
      await post({});
      expect(urlOf(FINISH).searchParams.has('title')).toBe(false);

      await post({ title: '' });
      expect(urlOf(FINISH + 3).searchParams.has('title')).toBe(false);
    });

    it('does not disturb the call that was already working', async () => {
      await post(undefined);

      const finish = urlOf(FINISH);
      expect(finish.searchParams.get('video_state')).toBe('PUBLISHED');
      expect(finish.searchParams.get('video_id')).toBe('vid-1');
      expect(finish.searchParams.get('access_token')).toBe('page-token');
    });
  });
});
