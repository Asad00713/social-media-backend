import { PinterestService } from './pinterest.service';

/**
 * The pin fields the composer drew but nothing sent: `alt_text`,
 * `ai_disclosures`, `board_section_id`, and the multi-image carousel.
 *
 * These assert the request BODY, because every mistake available here is
 * a naming one: `ai_disclosures` is an object wrapping an UPPERCASE enum,
 * and a carousel is a different `source_type` rather than an extra field.
 */
describe('PinterestService.createPin — the request body', () => {
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

  const bodyFor = async (
    options?: Parameters<PinterestService['createPin']>[5],
  ) => {
    await service.createPin(
      'token',
      'board-1',
      'Title',
      'Description',
      'https://example.test/a.jpg',
      options,
    );
    return JSON.parse(fetchMock.mock.calls[0][1].body as string);
  };

  it('names alt text as Pinterest spells it', async () => {
    const body = await bodyFor({ altText: 'A flat white on a wooden table' });

    expect(body.alt_text).toBe('A flat white on a wooden table');
  });

  it('caps alt text at the API limit', async () => {
    const body = await bodyFor({ altText: 'x'.repeat(900) });

    expect(body.alt_text).toHaveLength(500);
  });

  // The subtle one. A pin's disclosure is an OBJECT wrapping a list of
  // UPPERCASE values. The lowercase `ai_modified` belongs to the catalogs
  // API — a different enum on a different resource — and sending that
  // shape here would be rejected.
  it('sends the AI disclosure as an object of uppercase values', async () => {
    const body = await bodyFor({ aiModified: true });

    expect(body.ai_disclosures).toEqual({ values: ['AI_MODIFIED'] });
  });

  it.each([
    ['untouched', {}],
    ['switched off', { aiModified: false }],
  ])('sends no disclosure when %s', async (_label, options) => {
    const body = await bodyFor(options);

    expect('ai_disclosures' in body).toBe(false);
  });

  it('sends the board section when one was chosen', async () => {
    const body = await bodyFor({ boardSectionId: 'section-9' });

    expect(body.board_section_id).toBe('section-9');
  });

  it('omits every optional key when nothing was set', async () => {
    const body = await bodyFor();

    for (const key of ['alt_text', 'ai_disclosures', 'board_section_id']) {
      expect(key in body).toBe(false);
    }
  });

  describe('the media source', () => {
    it('stays a single image when there is one image', async () => {
      const body = await bodyFor();

      expect(body.media_source).toEqual({
        source_type: 'image_url',
        url: 'https://example.test/a.jpg',
      });
    });

    // A carousel is a different variant of the union, not an extra field:
    // `image_url` has a `url`, `multiple_image_urls` has `items`.
    it('becomes a carousel when extra images are passed', async () => {
      const body = await bodyFor({
        extraImageUrls: ['https://example.test/b.jpg'],
      });

      expect(body.media_source).toEqual({
        source_type: 'multiple_image_urls',
        items: [
          { url: 'https://example.test/a.jpg' },
          { url: 'https://example.test/b.jpg' },
        ],
      });
    });

    // The spec's maxItems is 5, counting the first image, so at most four
    // extras survive. Sending six would fail the whole pin.
    it('keeps at most five images in total', async () => {
      const body = await bodyFor({
        extraImageUrls: [
          'https://example.test/b.jpg',
          'https://example.test/c.jpg',
          'https://example.test/d.jpg',
          'https://example.test/e.jpg',
          'https://example.test/f.jpg',
        ],
      });

      expect(body.media_source.items).toHaveLength(5);
    });

    it('stays a single image when the extras are empty', async () => {
      const body = await bodyFor({ extraImageUrls: [] });

      expect(body.media_source.source_type).toBe('image_url');
    });
  });
});
