import { bucketByDate, presentPost, type PostRow } from './present-post';

const NOW = new Date('2026-06-15T10:00:00Z');
const users = new Map([
  ['u1', { id: 'u1', name: 'Asad', avatarUrl: null }],
  ['u2', { id: 'u2', name: 'Sana Khan', avatarUrl: 'https://x/a.png' }],
]);

function row(over: Partial<PostRow> = {}): PostRow {
  return {
    id: 'p1',
    workspaceId: 'w1',
    createdById: 'u1',
    content: 'hello',
    mediaItems: [],
    targets: [],
    status: 'scheduled',
    scheduledAt: NOW,
    publishedAt: null,
    platformContent: {},
    metadata: {},
    readyAt: null,
    readyById: null,
    jobId: 'job-secret',
    lastError: null,
    retryCount: '2',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as PostRow;
}

describe('presentPost', () => {
  it('flags a composer target that failed on auth as needing reconnect', () => {
    const dto = presentPost(
      row({
        status: 'failed',
        targets: [
          {
            channelId: '1',
            platform: 'twitter',
            publishStatus: 'failed',
            errorCode: 'auth_failed',
          },
        ] as never,
      }),
      { users },
    );
    expect(dto.targets[0].status).toBe('failed');
    expect(dto.targets[0].failure?.needsReconnect).toBe(true);
    expect(dto.displayStatus).toBe('failed');
  });

  it('shows partially_published while the stored status stays published', () => {
    const dto = presentPost(
      row({
        status: 'published',
        targets: [
          { channelId: '1', platform: 'twitter', status: 'published' },
          { channelId: '2', platform: 'facebook', status: 'failed' },
        ] as never,
      }),
      { users },
    );
    expect(dto.displayStatus).toBe('partially_published');
    expect(dto.status).toBe('published');
  });

  it('describes a legacy target by classifying its error message', () => {
    const dto = presentPost(
      row({
        status: 'failed',
        targets: [
          {
            channelId: '1',
            platform: 'twitter',
            status: 'failed',
            errorMessage: '429 too many requests',
          },
        ] as never,
      }),
      { users },
    );
    expect(dto.targets[0].failure?.message).toMatch(/limiting how often/);
  });

  it('exposes only the contract fields of a target, not stored internals', () => {
    const dto = presentPost(
      row({
        status: 'published',
        targets: [
          {
            channelId: 7,
            platform: 'twitter',
            status: 'published',
            publishStatus: 'published',
            retryCount: 3,
            attemptedAt: '2026-10-01T00:00:00Z',
            platformPostId: 'abc',
          },
        ] as never,
      }),
      { users },
    );
    expect(Object.keys(dto.targets[0]).sort()).toEqual([
      'channelId',
      'failure',
      'platform',
      'platformPostId',
      'status',
    ]);
    expect(dto.targets[0].channelId).toBe('7');
  });

  it('gives a published target no failure', () => {
    const dto = presentPost(
      row({
        status: 'published',
        targets: [
          { channelId: '1', platform: 'twitter', publishStatus: 'published' },
        ] as never,
      }),
      { users },
    );
    expect(dto.targets[0].failure).toBeNull();
  });

  it('lifts campaignId, keeps raw fields, and hides jobId', () => {
    const dto = presentPost(
      row({
        metadata: { campaignId: 'c1', title: 'T' },
        targets: [
          {
            channelId: '1',
            platform: 'twitter',
            status: 'published',
            platformPostUrl: 'https://t/1',
          },
        ] as never,
      }),
      { users },
    );
    expect(dto.campaignId).toBe('c1');
    expect(dto.metadata).toEqual({ campaignId: 'c1', title: 'T' });
    expect(dto.targets[0].platformPostUrl).toBe('https://t/1');
    expect(dto.retryCount).toBe('2');
    expect(dto).not.toHaveProperty('jobId');
    expect(presentPost(row(), { users }).campaignId).toBeNull();
  });

  it('uses publishedAt over scheduledAt for occurredAt', () => {
    const published = new Date('2026-06-15T11:00:00Z');
    const dto = presentPost(row({ publishedAt: published }), { users });
    expect(dto.occurredAt).toBe(published.toISOString());
    expect(
      presentPost(row({ scheduledAt: null }), { users }).occurredAt,
    ).toBeNull();
  });

  it('names the author and readyBy, and tolerates a missing user', () => {
    const dto = presentPost(
      row({ createdById: 'u9', readyAt: NOW, readyById: 'u2' }),
      { users },
    );
    expect(dto.author).toEqual({ id: 'u9', name: 'Unknown', avatarUrl: null });
    expect(dto.readyBy).toEqual({ id: 'u2', name: 'Sana Khan' });
    expect(dto.readyAt).toBe(NOW.toISOString());
  });
});

describe('bucketByDate', () => {
  const late = presentPost(
    row({ scheduledAt: new Date('2026-06-15T23:30:00Z') }),
    { users },
  );

  it('buckets by the workspace-local date', () => {
    expect(Object.keys(bucketByDate([late], 'Asia/Karachi'))).toEqual([
      '2026-06-16',
    ]);
    expect(Object.keys(bucketByDate([late], 'UTC'))).toEqual(['2026-06-15']);
  });
});
