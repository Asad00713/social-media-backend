import { FacebookService } from './facebook.service';

/**
 * The button on a link post is `call_to_action` on `POST /{page-id}/feed`, and
 * its own link has to be the post's link. A wrong shape fails quietly (ignored)
 * or rejects the whole post, so the request body is what these tests pin.
 */
describe('FacebookService.postToPage - the link post button', () => {
  let service: FacebookService;
  let fetchMock: jest.Mock;

  const sent = (call = 0) => ({
    url: String(fetchMock.mock.calls[call][0]),
    body: JSON.parse(fetchMock.mock.calls[call][1].body as string),
  });

  beforeEach(() => {
    service = new FacebookService();
    fetchMock = jest.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'post-1' }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('sends call_to_action as the reference’s own JSON text, beside the link', async () => {
    await service.postToPage(
      'page-1',
      'tok',
      'Read https://lumiere.pk/menu',
      'https://lumiere.pk/menu',
      'LEARN_MORE',
    );

    const { url, body } = sent();
    expect(url).toMatch(/\/page-1\/feed$/);
    expect(body.link).toBe('https://lumiere.pk/menu');
    expect(typeof body.call_to_action).toBe('string');
    expect(JSON.parse(body.call_to_action)).toEqual({
      type: 'LEARN_MORE',
      value: { link: 'https://lumiere.pk/menu' },
    });
  });

  it('puts the SAME link in the button as in the post', async () => {
    await service.postToPage('p', 't', 'm', 'https://a.example/x', 'SIGN_UP');
    const { body } = sent();
    expect(JSON.parse(body.call_to_action).value.link).toBe(body.link);
  });

  it('leaves the button out when none is chosen', async () => {
    await service.postToPage('p', 't', 'm', 'https://a.example/x');
    expect('call_to_action' in sent().body).toBe(false);
    expect(sent().body.link).toBe('https://a.example/x');
  });

  it('leaves the button out when there is no link to attach it to', async () => {
    await service.postToPage('p', 't', 'm', undefined, 'LEARN_MORE');
    expect('call_to_action' in sent().body).toBe(false);
    expect('link' in sent().body).toBe(false);
  });

  it('makes the request it always made for a plain text post', async () => {
    await service.postToPage('p', 'tok', 'hello');
    expect(sent().body).toEqual({ access_token: 'tok', message: 'hello' });
  });
});

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
