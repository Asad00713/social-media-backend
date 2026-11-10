import { FacebookService } from './facebook.service';

/**
 * A carousel is one `POST /{page-id}/feed` whose `child_attachments` carries
 * the cards. A wrong shape is refused whole, or ignored, and neither shows up
 * until publish - so the request body is what these tests pin.
 */
describe('FacebookService.postCarouselToPage', () => {
  let service: FacebookService;
  let fetchMock: jest.Mock;

  const sent = (call = 0) => ({
    url: String(fetchMock.mock.calls[call][0]),
    body: JSON.parse(fetchMock.mock.calls[call][1].body as string),
  });

  const cards = [
    {
      link: 'https://lumiere.pk/menu',
      picture: 'https://cdn.lumiere.pk/menu.jpg',
      name: 'Autumn menu',
      description: 'From Rs 450',
    },
    {
      link: 'https://lumiere.pk/bakes',
      picture: 'https://cdn.lumiere.pk/b.jpg',
    },
  ];

  beforeEach(() => {
    service = new FacebookService();
    fetchMock = jest.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'page-1_99' }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('posts to the Page feed with the link, the message and the cards as JSON text', async () => {
    const result = await service.postCarouselToPage(
      'page-1',
      'tok',
      'Autumn https://lumiere.pk/menu',
      'https://lumiere.pk/menu',
      cards,
    );

    const { url, body } = sent();
    expect(url).toMatch(/\/page-1\/feed$/);
    expect(body.access_token).toBe('tok');
    expect(body.message).toBe('Autumn https://lumiere.pk/menu');
    expect(body.link).toBe('https://lumiere.pk/menu');
    expect(typeof body.child_attachments).toBe('string');
    expect(JSON.parse(body.child_attachments)).toEqual(cards);
    expect(body.multi_share_optimized).toBe('false');
    expect(result).toEqual({ postId: 'page-1_99' });
  });

  it('sends no button: call_to_action is not documented on a carousel', async () => {
    await service.postCarouselToPage('p', 't', 'm', 'https://a.example', cards);
    expect('call_to_action' in sent().body).toBe(false);
  });

  it('carries the post options (audience, backdate, place)', async () => {
    await service.postCarouselToPage(
      'p',
      't',
      'm',
      'https://a.example',
      cards,
      {
        place: '123',
        backdatedTime: 1_700_000_000,
      },
    );
    expect(sent().body.place).toBe('123');
    expect(sent().body.backdated_time).toBe('1700000000');
  });

  it("surfaces Facebook's own refusal", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: '(#100) picture is required' } }),
    });
    await expect(
      service.postCarouselToPage('p', 't', 'm', 'https://a.example', cards),
    ).rejects.toThrow('(#100) picture is required');
  });
});
