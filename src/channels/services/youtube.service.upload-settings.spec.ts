import { YouTubeService } from './youtube.service';
import { QuotaTrackerService } from '../../quota/quota-tracker.service';

/**
 * Three upload settings, and the interesting one is `notifySubscribers`:
 * it is a QUERY parameter, not a body field, and YouTube's default is
 * TRUE. So it is the one setting here that only matters when turning
 * something off — the opposite of every disclosure in this composer.
 */
describe('YouTubeService — upload settings', () => {
  let service: YouTubeService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    service = new YouTubeService({
      reserve: jest.fn().mockResolvedValue(undefined),
      refund: jest.fn().mockResolvedValue(undefined),
    } as unknown as QuotaTrackerService);

    fetchMock = jest.fn(async (input: unknown) => {
      const url = String(input);
      // The video download.
      if (!url.includes('googleapis.com')) {
        return {
          ok: true,
          headers: new Headers({ 'content-type': 'video/mp4' }),
          arrayBuffer: async () => new ArrayBuffer(8),
        };
      }
      // The resumable-upload init, which answers with the session URL.
      if (url.includes('uploadType=resumable')) {
        return {
          ok: true,
          headers: new Headers({
            location: 'https://upload.googleapis.com/session/1',
          }),
          text: async () => '',
          json: async () => ({}),
        };
      }
      // The upload itself.
      return {
        ok: true,
        headers: new Headers(),
        json: async () => ({
          id: 'vid-1',
          snippet: { title: 'T' },
          status: { uploadStatus: 'uploaded' },
        }),
        text: async () => '',
      };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  /** The init call: its URL and parsed metadata body. */
  const initCall = () => {
    const call = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('uploadType=resumable'),
    )!;
    return {
      url: new URL(String(call[0])),
      body: JSON.parse(call[1].body as string),
    };
  };

  const upload = (options: Record<string, unknown>) =>
    service.uploadVideoFromUrl('token', 'https://example.test/v.mp4', {
      title: 'T',
      ...options,
    });

  it('sends the language on the snippet', async () => {
    await upload({ defaultLanguage: 'ur' });

    expect(initCall().body.snippet.defaultLanguage).toBe('ur');
  });

  // An EMPTY string is the case the guard exists for, and the only one.
  // `JSON.stringify` already drops an undefined key, so a mutation that
  // removes the guard is invisible until something sends `''` — which
  // YouTube rejects with `defaultLanguageNotSet` rather than ignoring.
  it.each([
    ['nothing was chosen', undefined],
    ['the code is empty', ''],
  ])('sends no language key when %s', async (_label, defaultLanguage) => {
    await upload({ defaultLanguage });

    expect('defaultLanguage' in initCall().body.snippet).toBe(false);
  });

  it('declares altered content on the status', async () => {
    await upload({ containsSyntheticMedia: true });

    expect(initCall().body.status.containsSyntheticMedia).toBe(true);
  });

  // A declaration, never a denial: absent already means "not altered".
  it.each([
    ['untouched', {}],
    ['explicitly false', { containsSyntheticMedia: false }],
  ])('sends no synthetic-media key when %s', async (_label, options) => {
    await upload(options);

    expect('containsSyntheticMedia' in initCall().body.status).toBe(false);
  });

  describe('notifySubscribers', () => {
    // The whole point: YouTube notifies by default, so silence has to be
    // asked for explicitly.
    it('is sent as false to silence the notification', async () => {
      await upload({ notifySubscribers: false });

      expect(initCall().url.searchParams.get('notifySubscribers')).toBe(
        'false',
      );
    });

    // Sending `true` would be a no-op, and an absent parameter already
    // notifies — so nothing is sent.
    it.each([
      ['nothing was chosen', {}],
      ['notifications were left on', { notifySubscribers: true }],
    ])('sends no parameter when %s', async (_label, options) => {
      await upload(options);

      expect(initCall().url.searchParams.has('notifySubscribers')).toBe(
        false,
      );
    });

    it('is a query parameter, not a body field', async () => {
      await upload({ notifySubscribers: false });

      const { body } = initCall();
      expect('notifySubscribers' in body).toBe(false);
      expect('notifySubscribers' in body.snippet).toBe(false);
      expect('notifySubscribers' in body.status).toBe(false);
    });
  });

  it('still sends the parts it always did', async () => {
    await upload({});

    const { url, body } = initCall();
    expect(url.searchParams.get('part')).toBe('snippet,status');
    expect(body.snippet.title).toBe('T');
    expect(body.status.privacyStatus).toBe('private');
  });
});
