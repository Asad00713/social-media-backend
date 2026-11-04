import { InstagramService } from './instagram.service';

/**
 * The container body for the composer's Instagram settings — the one place
 * parameter NAMES and PLACEMENT are visible.
 *
 * The publisher's tests hand a camelCase object straight to the service and
 * would stay green against a misspelt parameter, a number that never reached
 * the form, or a setting sent on the wrong container. A wrong placement fails
 * quietly at Meta (the container is rejected, or the setting is dropped), so
 * each one is pinned here against the real form body.
 */
describe('InstagramService — container settings on the request body', () => {
  let service: InstagramService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    service = new InstagramService();
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'container-1', status_code: 'FINISHED' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  /** The parsed form body of every POST to `/media`, in call order. */
  const containerForms = () =>
    fetchMock.mock.calls
      .filter(
        ([url, init]) =>
          String(url).endsWith('/media') && init?.method === 'POST',
      )
      .map(([, init]) => new URLSearchParams(init.body.toString()));

  /** The one POST to `/media` a single-media post makes. */
  const onlyContainer = () => {
    const forms = containerForms();
    expect(forms).toHaveLength(1);
    return forms[0];
  };

  const publishImage = (settings: Record<string, unknown>) =>
    service.createImagePostWithUserToken(
      'user',
      'token',
      'https://example.test/a.jpg',
      'caption',
      settings,
    );

  const publishVideo = (
    mediaType: 'REELS' | 'VIDEO',
    settings: Record<string, unknown>,
  ) =>
    service.createVideoPostWithUserToken(
      'user',
      'token',
      'https://example.test/v.mp4',
      'caption',
      false,
      mediaType,
      settings,
    );

  // Videos only, so the carousel's aspect-ratio check (which downloads the
  // images to measure them) has nothing to fetch.
  const publishCarousel = (settings: Record<string, unknown>) =>
    service.createCarouselPostWithUserToken(
      'user',
      'token',
      [
        { type: 'VIDEO', url: 'https://example.test/1.mp4' },
        { type: 'VIDEO', url: 'https://example.test/2.mp4' },
      ],
      'caption',
      settings,
    );

  describe('the AI label (is_ai_generated)', () => {
    it('is sent as "true" on a feed image', async () => {
      await publishImage({ isAiGenerated: true });

      expect(onlyContainer().get('is_ai_generated')).toBe('true');
    });

    it('is sent on a Reel', async () => {
      await publishVideo('REELS', { isAiGenerated: true });

      expect(onlyContainer().get('is_ai_generated')).toBe('true');
    });

    // Left out rather than sent as "false": an absent parameter already
    // means "not disclosed", and an explicit false is one more key an older
    // API version can reject.
    it.each([
      ['false', { isAiGenerated: false }],
      ['absent', {}],
    ])('is not sent when it is %s', async (_label, settings) => {
      await publishImage(settings);

      expect(onlyContainer().has('is_ai_generated')).toBe(false);
    });

    // Meta: "only the carousel container needs ... setting this parameter on
    // carousel children will result in an error".
    it('goes on the carousel PARENT and never on a child', async () => {
      await publishCarousel({ isAiGenerated: true });

      const forms = containerForms();
      const children = forms.filter((f) => f.get('is_carousel_item') === 'true');
      const parent = forms.filter((f) => f.get('media_type') === 'CAROUSEL');

      expect(children).toHaveLength(2);
      expect(parent).toHaveLength(1);
      expect(parent[0].get('is_ai_generated')).toBe('true');
      for (const child of children) {
        expect(child.has('is_ai_generated')).toBe(false);
      }
    });
  });

  describe('a Reel cover frame (thumb_offset)', () => {
    it('is sent as whole milliseconds', async () => {
      await publishVideo('REELS', { thumbOffset: 2500 });

      expect(onlyContainer().get('thumb_offset')).toBe('2500');
    });

    it('rounds a fractional offset to a whole millisecond', async () => {
      await publishVideo('REELS', { thumbOffset: 1500.6 });

      expect(onlyContainer().get('thumb_offset')).toBe('1501');
    });

    // The first frame is a real choice, not an absent one.
    it('sends zero', async () => {
      await publishVideo('REELS', { thumbOffset: 0 });

      expect(onlyContainer().get('thumb_offset')).toBe('0');
    });

    it.each([
      ['negative', -1],
      ['not a number', Number.NaN],
      ['infinite', Number.POSITIVE_INFINITY],
      ['absent', undefined],
    ])('is not sent when it is %s', async (_label, thumbOffset) => {
      await publishVideo('REELS', { thumbOffset });

      expect(onlyContainer().has('thumb_offset')).toBe(false);
    });

    // Reels-only here: the composer offers a cover frame on a Reel alone,
    // and a plain VIDEO container is the legacy shape.
    it('is not sent on a plain video', async () => {
      await publishVideo('VIDEO', { thumbOffset: 2500 });

      expect(onlyContainer().has('thumb_offset')).toBe(false);
    });
  });

  describe('a Reel audio name (audio_name)', () => {
    it('is sent as given', async () => {
      await publishVideo('REELS', { audioName: 'Lumiere — house blend' });

      expect(onlyContainer().get('audio_name')).toBe('Lumiere — house blend');
    });

    it('is trimmed', async () => {
      await publishVideo('REELS', { audioName: '  Morning pour  ' });

      expect(onlyContainer().get('audio_name')).toBe('Morning pour');
    });

    // Meta allows ONE rename; a blank name would spend it on nothing.
    it.each([
      ['blank', '   '],
      ['empty', ''],
      ['absent', undefined],
    ])('is not sent when it is %s', async (_label, audioName) => {
      await publishVideo('REELS', { audioName });

      expect(onlyContainer().has('audio_name')).toBe(false);
    });

    it('is not sent on a plain video', async () => {
      await publishVideo('VIDEO', { audioName: 'Morning pour' });

      expect(onlyContainer().has('audio_name')).toBe(false);
    });
  });
});
