import { LinkedInService } from './linkedin.service';

/**
 * `isReshareDisabledByAuthor` on the poll path.
 *
 * It was hard-coded `false`, and the composer's "Allow reposts" switch
 * had no writer. Only this path can carry it: every other LinkedIn
 * publish here goes through the legacy `/v2/ugcPosts`, which has no
 * reshare field at all. Moving the rest means migrating six call sites
 * to the versioned Posts API — its own effort, not this one.
 */
describe('LinkedInService.createPollPost — reshare control', () => {
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

  it('still posts to the versioned Posts API', async () => {
    await bodyFor(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/posts');
    expect(init.headers['LinkedIn-Version']).toBeTruthy();
  });
});
