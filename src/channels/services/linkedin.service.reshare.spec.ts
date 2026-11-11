import { LinkedInService } from './linkedin.service';

/**
 * The poll request: `isReshareDisabledByAuthor`, and since the poll moved
 * off `/v2/posts` + a hard-coded `LinkedIn-Version: 202404`, the same
 * `/rest/posts` request, version and envelope as every other format.
 */
describe('LinkedInService.createPollPost — request', () => {
  let service: LinkedInService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    service = new LinkedInService();
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers({ 'x-restli-id': 'urn:li:share:1' }),
      json: async () => ({ id: 'urn:li:share:1' }),
      text: async () => '',
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const bodyFor = async (disableReshare?: boolean) => {
    await service.createPollPost(
      'token',
      'urn:li:person:me',
      'Which roast?',
      ['Light', 'Dark'],
      7,
      'commentary',
      'PUBLIC',
      disableReshare,
    );
    return JSON.parse(fetchMock.mock.calls[0][1].body as string);
  };

  it('disables resharing when the author asked', async () => {
    expect((await bodyFor(true)).isReshareDisabledByAuthor).toBe(true);
  });

  // Unlike a disclosure, this field is always present on the body — the
  // API expects it — so the default has to be the permissive value
  // rather than an omission.
  it.each([
    ['explicitly allowed', false],
    ['nothing was chosen', undefined],
  ])('leaves resharing on when %s', async (_label, value) => {
    expect((await bodyFor(value)).isReshareDisabledByAuthor).toBe(false);
  });

  it('posts to the versioned /rest/posts with the same version as every other call', async () => {
    await bodyFor(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.linkedin.com/rest/posts');
    expect(String(url)).not.toContain('/v2/');

    // The poll used a hard-coded 202404 while the rest sent the shared
    // constant. Pin the invariant, not the number: whatever a text post
    // sends, the poll sends.
    fetchMock.mockClear();
    await service.createRestTextPost('token', 'urn:li:person:me', 'x');
    const textVersion = fetchMock.mock.calls[0][1].headers['Linkedin-Version'];
    expect(textVersion).toMatch(/^\d{6}$/);
    expect(init.headers['Linkedin-Version']).toBe(textVersion);
    expect(init.headers['LinkedIn-Version']).toBeUndefined();
    expect(init.headers['X-Restli-Protocol-Version']).toBe('2.0.0');
  });

  it('sends the commentary as little text, the question and options as typed', async () => {
    await service.createPollPost(
      'token',
      'urn:li:person:me',
      'Light (or dark)?',
      ['Light #1', 'Dark_roast'],
      7,
      'Vote (please) #coffee',
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.commentary).toBe('Vote \\(please\\) {hashtag|\\#|coffee}');
    // Poll schema: `question` and option `text` are plain Strings.
    expect(body.content.poll.question).toBe('Light (or dark)?');
    expect(body.content.poll.options).toEqual([
      { text: 'Light #1' },
      { text: 'Dark_roast' },
    ]);
  });

  it('carries a signed-in-members audience, and a page posts PUBLIC', async () => {
    const audience = async (author: string) => {
      fetchMock.mockClear();
      await service.createPollPost(
        'token',
        author,
        'Q?',
        ['A', 'B'],
        7,
        '',
        'LOGGED_IN',
      );
      return JSON.parse(fetchMock.mock.calls[0][1].body as string).visibility;
    };
    expect(await audience('urn:li:person:me')).toBe('LOGGED_IN');
    expect(await audience('urn:li:organization:42')).toBe('PUBLIC');
  });
});
