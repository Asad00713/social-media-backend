import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { YouTubeService } from './youtube.service';

/** Build a comment thread whose newest activity is at `iso`. */
function thread(id: string, iso: string, replyIso?: string) {
  const snippet = {
    textDisplay: 't',
    textOriginal: 't',
    authorDisplayName: 'a',
    authorProfileImageUrl: 'u',
    publishedAt: iso,
    updatedAt: iso,
  };
  return {
    id,
    snippet: { topLevelComment: { id: `${id}-top`, snippet } },
    replies: replyIso
      ? {
          comments: [
            {
              id: `${id}-r`,
              snippet: { ...snippet, publishedAt: replyIso, updatedAt: replyIso },
            },
          ],
        }
      : undefined,
  };
}

function page(items: unknown[], nextPageToken?: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ items, nextPageToken }),
    text: async () => '',
  };
}

async function build() {
  const mod = await Test.createTestingModule({
    providers: [
      YouTubeService,
      { provide: ConfigService, useValue: { get: () => undefined } },
    ],
  }).compile();
  return mod.get(YouTubeService);
}

describe('YouTubeService.fetchVideoComments early exit', () => {
  afterEach(() => jest.restoreAllMocks());

  it('stops paging at the first page with nothing newer than `since`', async () => {
    const since = new Date('2026-07-10T00:00:00Z');
    const fetchMock = jest
      .fn()
      // Page 1 — all newer than `since`, so keep going.
      .mockResolvedValueOnce(
        page([thread('a', '2026-07-12T00:00:00Z')], 'PAGE2'),
      )
      // Page 2 — all older than `since`. Exit here.
      .mockResolvedValueOnce(
        page([thread('b', '2026-07-01T00:00:00Z')], 'PAGE3'),
      )
      // Page 3 must never be requested.
      .mockResolvedValueOnce(page([thread('c', '2026-06-01T00:00:00Z')]));
    global.fetch = fetchMock as unknown as typeof fetch;

    const svc = await build();
    const out = await svc.fetchVideoComments('TKN', 'vid', since);

    // 2 calls, not 5 — this is the whole point of the change.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('keeps paging when an old thread has a new reply', async () => {
    const since = new Date('2026-07-10T00:00:00Z');
    const fetchMock = jest
      .fn()
      // Top-level is old but the reply is new — this page HAS new activity.
      .mockResolvedValueOnce(
        page(
          [thread('a', '2026-01-01T00:00:00Z', '2026-07-15T00:00:00Z')],
          'PAGE2',
        ),
      )
      .mockResolvedValueOnce(page([thread('b', '2026-01-01T00:00:00Z')]));
    global.fetch = fetchMock as unknown as typeof fetch;

    const svc = await build();
    await svc.fetchVideoComments('TKN', 'vid', since);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still honors the 5-page cap when `since` is undefined', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(page([thread('x', '2026-07-12T00:00:00Z')], 'MORE'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const svc = await build();
    await svc.fetchVideoComments('TKN', 'vid');

    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
