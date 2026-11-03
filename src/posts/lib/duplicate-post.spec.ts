/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- partial-row test doubles */
import { BadRequestException } from '@nestjs/common';
import type { PostRow } from './present-post';
import { buildDuplicate } from './duplicate-post';

const USER = 'caller-1';

function source(over: Partial<PostRow> = {}): PostRow {
  return {
    id: 'src-1',
    workspaceId: 'ws-1',
    createdById: 'author-1',
    content: 'Launch day',
    mediaItems: [{ url: 'https://x.test/a.png', type: 'image' }],
    targets: [
      {
        channelId: 'ch-1',
        platform: 'twitter',
        status: 'published',
        publishStatus: 'published',
        platformPostId: 'tw-1',
        platformPostUrl: 'https://x.test/p/1',
        publishedAt: '2026-01-01T00:00:00Z',
        errorMessage: 'boom',
        errorCode: 'E1',
        retryCount: 3,
        contentOverride: { text: 'short' },
        destination: { id: 'C1', name: 'general' },
      },
    ],
    status: 'published',
    scheduledAt: new Date('2026-01-01T00:00:00Z'),
    publishedAt: new Date('2026-01-01T00:00:01Z'),
    platformContent: { twitter: { text: 'tweet' } },
    metadata: {
      hashtags: ['a'],
      firstComment: 'hi',
      campaignId: 'camp-1',
      schedule: { x: 1 },
      firstWeekSlot: 2,
      suggestedAt: '2026-01-01',
      imageCredit: 'someone',
      source: 'first_week',
    },
    readyAt: new Date(),
    readyById: 'author-1',
    jobId: 'job-1',
    lastError: 'bad',
    retryCount: '2',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as unknown as PostRow;
}

describe('buildDuplicate', () => {
  it('starts a clean, not-ready draft owned by the caller', () => {
    const out = buildDuplicate(source(), USER) as Record<string, any>;
    expect(out).toMatchObject({
      status: 'draft',
      scheduledAt: null,
      publishedAt: null,
      jobId: null,
      lastError: null,
      retryCount: '0',
      readyAt: null,
      readyById: null,
      createdById: USER,
      workspaceId: 'ws-1',
    });
    expect(out).not.toHaveProperty('id');
  });

  it('keeps caption and media, and rebuilds targets without publish traces', () => {
    const out = buildDuplicate(source(), USER) as Record<string, any>;
    expect(out.content).toBe('Launch day');
    expect(out.mediaItems).toEqual([
      { url: 'https://x.test/a.png', type: 'image' },
    ]);
    expect(out.platformContent).toEqual({ twitter: { text: 'tweet' } });
    expect(out.targets).toEqual([
      {
        channelId: 'ch-1',
        platform: 'twitter',
        status: 'draft',
        publishStatus: 'queued',
        retryCount: 0,
        destination: { id: 'C1', name: 'general' },
        contentOverride: { text: 'short' },
      },
    ]);
    const t = out.targets[0];
    for (const k of [
      'platformPostId',
      'platformPostUrl',
      'publishedAt',
      'errorMessage',
      'errorCode',
    ]) {
      expect(t).not.toHaveProperty(k);
    }
  });

  it('strips campaign and schedule metadata, keeps the rest', () => {
    const out = buildDuplicate(source(), USER) as Record<string, any>;
    expect(out.metadata).toEqual({
      hashtags: ['a'],
      firstComment: 'hi',
      source: 'composer',
    });
  });

  it('keeps a non first_week source value', () => {
    const out = buildDuplicate(
      source({ metadata: { source: 'maestro' } as never }),
      USER,
    ) as Record<string, any>;
    expect(out.metadata).toEqual({ source: 'maestro' });
  });

  it('does not alias the source arrays and objects', () => {
    const src = source();
    const out = buildDuplicate(src, USER) as Record<string, any>;
    expect(out.mediaItems).not.toBe(src.mediaItems);
    expect(out.platformContent).not.toBe(src.platformContent);
  });

  describe('options', () => {
    const two = () =>
      source({
        targets: [
          ...(source().targets as any[]),
          {
            channelId: '7',
            platform: 'facebook',
            status: 'published',
            publishStatus: 'published',
            platformPostId: 'fb-1',
          },
        ] as never,
      });

    it('no options: copies every target, as today', () => {
      const out = buildDuplicate(two(), USER) as Record<string, any>;
      expect(
        (out.targets as Array<{ channelId: string }>).map((t) => t.channelId),
      ).toEqual(['ch-1', '7']);
    });

    it('channelId keeps only that target', () => {
      const out = buildDuplicate(two(), USER, { channelId: 7 }) as Record<
        string,
        any
      >;
      expect(out.targets).toEqual([
        {
          channelId: '7',
          platform: 'facebook',
          status: 'draft',
          publishStatus: 'queued',
          retryCount: 0,
        },
      ]);
      expect(out.content).toBe('Launch day');
      expect(out.mediaItems).toHaveLength(1);
    });

    it('channelId not on the post: 400, nothing built', () => {
      expect(() => buildDuplicate(two(), USER, { channelId: 99 })).toThrow(
        BadRequestException,
      );
    });

    it('channelId together with noTargets is a 400', () => {
      expect(() =>
        buildDuplicate(two(), USER, { channelId: 7, noTargets: true }),
      ).toThrow(BadRequestException);
    });

    it('noTargets gives an empty list and keeps media and caption', () => {
      const out = buildDuplicate(two(), USER, { noTargets: true }) as Record<
        string,
        any
      >;
      expect(out.targets).toEqual([]);
      expect(out.content).toBe('Launch day');
      expect(out.mediaItems).toEqual([
        { url: 'https://x.test/a.png', type: 'image' },
      ]);
    });

    it('imported source: media dropped, caption kept, platformContent media dropped', () => {
      const out = buildDuplicate(
        source({
          metadata: { syncedFrom: 'platform', syncedAt: 'now' } as never,
          platformContent: {
            twitter: {
              text: 'tweet',
              mediaItems: [{ url: 'https://cdn.test/t.jpg', type: 'image' }],
            },
          } as never,
        }),
        USER,
      ) as Record<string, any>;
      expect(out.mediaItems).toEqual([]);
      expect(out.content).toBe('Launch day');
      expect(out.platformContent).toEqual({ twitter: { text: 'tweet' } });
    });

    it('imported source: a per-channel override loses its media too', () => {
      const out = buildDuplicate(
        source({
          metadata: { syncedFrom: 'platform' } as never,
          targets: [
            {
              channelId: 'ch-1',
              platform: 'twitter',
              status: 'published',
              contentOverride: {
                text: 'short',
                mediaItems: [{ url: 'https://cdn.test/t.jpg', type: 'image' }],
              },
            },
          ] as never,
        }),
        USER,
      ) as Record<string, any>;
      expect(out.targets[0].contentOverride).toEqual({ text: 'short' });
    });

    it('a non-imported source keeps its platformContent media', () => {
      const out = buildDuplicate(
        source({
          platformContent: {
            twitter: { text: 't', mediaItems: [{ url: 'u', type: 'image' }] },
          } as never,
        }),
        USER,
      ) as Record<string, any>;
      expect(out.platformContent.twitter.mediaItems).toHaveLength(1);
    });

    it('syncedFrom and syncedAt are stripped from metadata', () => {
      const out = buildDuplicate(
        source({
          metadata: {
            syncedFrom: 'platform',
            syncedAt: '2026-01-01',
            hashtags: ['a'],
          } as never,
        }),
        USER,
      ) as Record<string, any>;
      expect(out.metadata).toEqual({ hashtags: ['a'] });
    });
  });
});
