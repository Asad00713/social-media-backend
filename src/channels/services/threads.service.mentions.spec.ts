import { ThreadsService } from './threads.service';

describe('ThreadsService.getMentions', () => {
  const svc = new ThreadsService();
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('calls the mentions endpoint and maps fields', async () => {
    const calledUrls: string[] = [];
    global.fetch = jest.fn(async (url: string) => {
      calledUrls.push(url);
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'm1',
              text: 'hey @schedura',
              username: 'alice',
              permalink: 'https://threads.net/@alice/post/1',
              timestamp: '2026-07-01T10:00:00+0000',
              media_type: 'TEXT_POST',
            },
          ],
        }),
      };
    }) as unknown as typeof fetch;

    const out = await svc.getMentions('tok', '123');
    expect(calledUrls[0]).toContain('/123/mentions');
    expect(calledUrls[0]).toContain('access_token=tok');
    expect(out).toEqual([
      {
        id: 'm1',
        text: 'hey @schedura',
        authorUsername: 'alice',
        permalink: 'https://threads.net/@alice/post/1',
        timestamp: '2026-07-01T10:00:00+0000',
        mediaType: 'TEXT_POST',
      },
    ]);
  });

  it('degrades to [] on a permission error (missing scope on old tokens)', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      json: async () => ({ error: { message: 'permissions error', code: 10 } }),
    })) as unknown as typeof fetch;
    await expect(svc.getMentions('tok', '123')).resolves.toEqual([]);
  });
});
