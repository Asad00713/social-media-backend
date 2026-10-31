import { ConfigService } from '@nestjs/config';
import { MastodonService } from './mastodon.service';

/**
 * The poll on a status, and the one rule that shapes the whole feature:
 * Mastodon takes a poll OR media attachments, never both.
 *
 * These assert the request body, since `poll[options][]` is a nested
 * shape and a status is rejected whole for a malformed one.
 */
describe('MastodonService.createStatus — the poll', () => {
  let service: MastodonService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    service = new MastodonService({
      get: () => undefined,
    } as unknown as ConfigService);

    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'status-1', url: 'https://m.test/1' }),
      text: async () => '',
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const bodyFor = async (
    options?: Parameters<MastodonService['createStatus']>[3],
  ) => {
    await service.createStatus(
      'https://mastodon.test',
      'token',
      'Iced Spanish latte is back',
      options,
    );
    return JSON.parse(fetchMock.mock.calls[0][1].body as string);
  };

  it('sends the poll as Mastodon spells it', async () => {
    const body = await bodyFor({
      poll: {
        options: ['one', 'two'],
        expiresInSeconds: 86400,
        multiple: true,
      },
    });

    expect(body.poll).toEqual({
      options: ['one', 'two'],
      expires_in: 86400,
      multiple: true,
    });
  });

  it('defaults multiple to false rather than omitting it', async () => {
    const body = await bodyFor({
      poll: { options: ['one', 'two'], expiresInSeconds: 3600 },
    });

    expect(body.poll.multiple).toBe(false);
  });

  // The rule that shapes the feature. Media is already uploaded by the
  // time this runs, so dropping the poll loses one setting while dropping
  // the media would lose the upload too.
  it('drops the poll when the status carries media', async () => {
    const body = await bodyFor({
      mediaIds: ['m-1'],
      poll: { options: ['one', 'two'], expiresInSeconds: 3600 },
    });

    expect('poll' in body).toBe(false);
    expect(body.media_ids).toEqual(['m-1']);
  });

  it('keeps the poll when the media list is empty', async () => {
    const body = await bodyFor({
      mediaIds: [],
      poll: { options: ['one', 'two'], expiresInSeconds: 3600 },
    });

    expect(body.poll.options).toEqual(['one', 'two']);
  });

  it('trims the answers and drops the blank ones', async () => {
    const body = await bodyFor({
      poll: {
        options: ['  one  ', '   ', 'two'],
        expiresInSeconds: 3600,
      },
    });

    expect(body.poll.options).toEqual(['one', 'two']);
  });

  // A poll needs two answers to be a poll, and the stock instance caps
  // at four — both refused rather than discovered as a rejected post.
  it('sends no poll when only one answer survives', async () => {
    const body = await bodyFor({
      poll: { options: ['only', '  '], expiresInSeconds: 3600 },
    });

    expect('poll' in body).toBe(false);
  });

  it('keeps at most four answers', async () => {
    const body = await bodyFor({
      poll: {
        options: ['a', 'b', 'c', 'd', 'e'],
        expiresInSeconds: 3600,
      },
    });

    expect(body.poll.options).toEqual(['a', 'b', 'c', 'd']);
  });

  it('sends no poll key when there is no poll', async () => {
    const body = await bodyFor({ visibility: 'public' });

    expect('poll' in body).toBe(false);
  });
});
