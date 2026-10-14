/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FirstWeekService } from './first-week.service';

const WS = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-14T10:00:00Z');
const FUTURE = '2026-10-16T04:00:00.000Z';
const PAST = '2026-10-13T04:00:00.000Z';

const post = (id: string, over: any = {}) => ({
  id,
  status: 'draft',
  content: `caption ${id}`,
  mediaItems: [{ url: 'https://img/x.jpg', type: 'image' }],
  targets: [{ channelId: '7', platform: 'facebook' }],
  scheduledAt: null,
  metadata: { source: 'first_week', firstWeekSlot: 0, suggestedAt: FUTURE },
  ...over,
});

const profile = (over: any = {}) => ({
  workspaceId: WS,
  sells: 'Coffee',
  voice: ['Warm'],
  audience: 'Everyone',
  source: 'posts',
  sourceChannelId: 7,
  sourcePlatform: 'instagram',
  postsRead: 10,
  status: 'ready',
  draftedCount: 5,
  weekStartsOn: '2026-10-15',
  weekEndsAt: new Date('2026-10-19T04:00:00Z'),
  error: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

function make(over: { profile?: any; rows?: any[] } = {}) {
  const state = {
    profile: over.profile === undefined ? profile() : over.profile,
    rows: over.rows ?? [],
  };
  const repo = {
    getProfile: jest.fn(async () => state.profile),
    getWorkspace: jest.fn(async () => ({
      id: WS,
      timezone: 'Asia/Karachi',
      ownerId: 'owner',
      logo: null,
    })),
    countPublishingChannels: jest.fn(async () => 2),
    listFirstWeekDrafts: jest.fn(async () => state.rows),
    insertProfileIfAbsent: jest.fn(async () => true),
    saveDescribedBrand: jest.fn(async () => undefined),
    updateBrand: jest.fn(async () => undefined),
    setStatus: jest.fn(
      async (_w: string, status: string, error: string | null = null) => {
        state.profile = { ...state.profile, status, error };
      },
    ),
  };
  const queue = { enqueue: jest.fn(async () => undefined) };
  const drafts = {
    findById: jest.fn(async (_w: string, id: string) => ({
      id,
      base: {
        text: `caption ${id}`,
        mediaItems: [],
        hashtags: [],
        mentions: [],
      },
      perPlatform: {},
      channels: [
        {
          channelId: '7',
          platform: 'facebook',
          publishStatus: 'queued',
          retryCount: 0,
        },
      ],
    })),
  };
  const scheduling = {
    schedule: jest.fn(async (_w: string, _u: string, dto: any) => ({
      postId: dto.draftId,
      scheduledAt: dto.scheduledAt,
      status: 'scheduled',
    })),
    cancel: jest.fn(async () => ({ success: true })),
  };
  const tokens = {
    getWorkspaceAiUsage: jest.fn(async () => ({
      resetsAt: new Date('2026-11-01T00:00:00Z'),
    })),
  };
  const svc = new FirstWeekService(
    repo as any,
    queue as any,
    drafts as any,
    scheduling as any,
    tokens as any,
  );
  return { svc, repo, queue, drafts, scheduling, state };
}

describe('FirstWeekService.getState', () => {
  it('returns the profile, drafts ordered by slot, and the workspace context', async () => {
    const { svc } = make({
      rows: [
        post('b', {
          metadata: {
            source: 'first_week',
            firstWeekSlot: 1,
            suggestedAt: FUTURE,
          },
        }),
        post('a', {
          metadata: {
            source: 'first_week',
            firstWeekSlot: 0,
            suggestedAt: FUTURE,
          },
        }),
      ],
    });
    const s = await svc.getState(WS, NOW);
    expect(s.profile?.status).toBe('ready');
    expect(s.drafts.map((d) => d.id)).toEqual(['a', 'b']);
    expect(s.hasChannels).toBe(true);
    expect(s.timezone).toBe('Asia/Karachi');
    expect(s.tokensResetAt).toBe('2026-11-01T00:00:00.000Z');
  });

  it('is profile: null with no drafts for a workspace that never started one', async () => {
    const { svc, repo } = make({ profile: null });
    repo.countPublishingChannels.mockResolvedValue(0);
    const s = await svc.getState(WS, NOW);
    expect(s.profile).toBeNull();
    expect(s.drafts).toEqual([]);
    expect(s.hasChannels).toBe(false);
  });

  it('drops rows that carry no usable slot instead of failing the whole response', async () => {
    const { svc } = make({
      rows: [post('ok'), post('bad', { metadata: { source: 'first_week' } })],
    });
    expect((await svc.getState(WS, NOW)).drafts.map((d) => d.id)).toEqual([
      'ok',
    ]);
  });

  it.each(['reading', 'drafting'])(
    'reports a stale %s run as failed/stalled without writing',
    async (status) => {
      const { svc, repo } = make({
        profile: profile({
          status,
          updatedAt: new Date(NOW.getTime() - 10 * 60 * 1000 - 1),
        }),
      });
      const s = await svc.getState(WS, NOW);
      expect(s.profile?.status).toBe('failed');
      expect(s.profile?.error).toBe('stalled');
      expect(repo.setStatus).not.toHaveBeenCalled();
    },
  );

  it.each(['reading', 'drafting'])(
    'leaves a fresh %s run as it is',
    async (status) => {
      const { svc } = make({
        profile: profile({
          status,
          updatedAt: new Date(NOW.getTime() - 60 * 1000),
        }),
      });
      expect((await svc.getState(WS, NOW)).profile?.status).toBe(status);
    },
  );

  it('does not rewrite an old ready profile', async () => {
    const { svc } = make({
      profile: profile({
        status: 'ready',
        updatedAt: new Date(NOW.getTime() - 86_400_000),
      }),
    });
    expect((await svc.getState(WS, NOW)).profile?.status).toBe('ready');
  });

  it('404s for a workspace that does not exist', async () => {
    const { svc, repo } = make();
    repo.getWorkspace.mockResolvedValue(null as any);
    await expect(svc.getState(WS, NOW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('FirstWeekService.saveBrand', () => {
  const dto = {
    sells: '  Bikes ',
    voice: [' Bold ', 'bold'],
    audience: ' Commuters ',
  };
  const clean = { sells: 'Bikes', voice: ['Bold'], audience: 'Commuters' };

  it('creates a described profile and starts a described run when none exists', async () => {
    const { svc, repo, queue } = make({ profile: null });
    repo.getProfile
      .mockResolvedValueOnce(null as any)
      .mockResolvedValue(profile({ source: 'described', status: 'drafting' }));
    await svc.saveBrand(WS, 'u1', dto);
    expect(repo.insertProfileIfAbsent).toHaveBeenCalledWith(WS, {
      source: 'described',
      status: 'drafting',
      brand: clean,
    });
    expect(queue.enqueue).toHaveBeenCalledWith({
      workspaceId: WS,
      mode: 'described',
      userId: 'u1',
    });
  });

  it('falls through to an update when it lost the insert race', async () => {
    const { svc, repo, queue } = make({ profile: null });
    repo.insertProfileIfAbsent.mockResolvedValue(false);
    repo.getProfile
      .mockResolvedValueOnce(null as any)
      .mockResolvedValue(profile());
    await svc.saveBrand(WS, 'u1', dto);
    expect(repo.updateBrand).toHaveBeenCalledWith(WS, clean);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('updates a learned brand without redrafting', async () => {
    const { svc, repo, queue } = make();
    await svc.saveBrand(WS, 'u1', dto);
    expect(repo.updateBrand).toHaveBeenCalledWith(WS, clean);
    expect(repo.saveDescribedBrand).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it.each(['needs_description', 'failed', 'no_tokens'])(
    'describes a never-learned brand from %s and starts a described run',
    async (status) => {
      const { svc, repo, queue } = make({
        profile: profile({ sells: null, voice: [], audience: null, status }),
      });
      await svc.saveBrand(WS, 'u1', dto);
      expect(repo.saveDescribedBrand).toHaveBeenCalledWith(WS, clean);
      expect(queue.enqueue).toHaveBeenCalledWith({
        workspaceId: WS,
        mode: 'described',
        userId: 'u1',
      });
    },
  );

  it('409s while Maestro is still reading the posts', async () => {
    const { svc, queue } = make({
      profile: profile({
        sells: null,
        voice: [],
        audience: null,
        status: 'reading',
      }),
    });
    await expect(svc.saveBrand(WS, 'u1', dto)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('400s a brand that is empty after trimming', async () => {
    const { svc } = make();
    await expect(
      svc.saveBrand(WS, 'u1', { sells: '   ', voice: ['x'], audience: 'y' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('marks the profile failed (not stuck drafting) when the enqueue fails', async () => {
    const { svc, repo, queue } = make({
      profile: profile({
        sells: null,
        voice: [],
        audience: null,
        status: 'needs_description',
      }),
    });
    queue.enqueue.mockRejectedValue(new Error('redis down'));
    await expect(svc.saveBrand(WS, 'u1', dto)).rejects.toThrow('redis down');
    expect(repo.setStatus).toHaveBeenCalledWith(
      WS,
      'failed',
      'Could not start: redis down',
    );
  });
});

describe('FirstWeekService.retry', () => {
  it('404s with no profile', async () => {
    const { svc } = make({ profile: null });
    await expect(svc.retry(WS, 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(['reading', 'drafting', 'ready'])('409s from %s', async (status) => {
    const { svc, queue } = make({
      profile: profile({ status, updatedAt: NOW }),
    });
    await expect(svc.retry(WS, 'u1', NOW)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it.each(['failed', 'needs_description', 'no_tokens'])(
    're-enqueues from %s in the profile mode',
    async (status) => {
      const { svc, queue, repo } = make({
        profile: profile({ status, source: 'described' }),
      });
      await svc.retry(WS, 'u1');
      expect(queue.enqueue).toHaveBeenCalledWith({
        workspaceId: WS,
        mode: 'described',
        userId: 'u1',
      });
      expect(repo.setStatus).toHaveBeenCalledWith(WS, 'drafting', null);
    },
  );

  it.each(['reading', 'drafting'])(
    're-enqueues from a stale %s run',
    async (status) => {
      const stale = new Date(NOW.getTime() - 10 * 60 * 1000 - 1);
      const { svc, queue, repo } = make({
        profile: profile({ status, source: 'described', updatedAt: stale }),
      });
      await svc.retry(WS, 'u1', NOW);
      expect(repo.setStatus).toHaveBeenCalledWith(WS, 'drafting', null);
      expect(queue.enqueue).toHaveBeenCalledWith({
        workspaceId: WS,
        mode: 'described',
        userId: 'u1',
      });
    },
  );

  it('goes back to reading when the posts brand was never learned', async () => {
    const { svc, repo, queue } = make({
      profile: profile({
        status: 'needs_description',
        source: 'posts',
        sells: null,
        voice: [],
        audience: null,
      }),
    });
    await svc.retry(WS, 'u1');
    expect(repo.setStatus).toHaveBeenCalledWith(WS, 'reading', null);
    expect(queue.enqueue).toHaveBeenCalledWith({
      workspaceId: WS,
      mode: 'posts',
      userId: 'u1',
    });
  });

  it('resumes drafting (no re-learning) when the posts brand is already stored', async () => {
    const { svc, repo } = make({
      profile: profile({ status: 'failed', source: 'posts' }),
    });
    await svc.retry(WS, 'u1');
    expect(repo.setStatus).toHaveBeenCalledWith(WS, 'drafting', null);
  });

  it('marks failed again if the enqueue throws', async () => {
    const { svc, repo, queue } = make({
      profile: profile({ status: 'failed' }),
    });
    queue.enqueue.mockRejectedValue(new Error('redis down'));
    await expect(svc.retry(WS, 'u1')).rejects.toThrow('redis down');
    expect(repo.setStatus).toHaveBeenLastCalledWith(
      WS,
      'failed',
      'Could not start: redis down',
    );
  });
});

describe('FirstWeekService.schedule', () => {
  it('schedules each draft at its own suggestedAt through the composer path', async () => {
    const { svc, scheduling, drafts } = make({
      rows: [
        post('a'),
        post('b', {
          metadata: {
            source: 'first_week',
            firstWeekSlot: 1,
            suggestedAt: '2026-10-17T13:00:00.000Z',
          },
        }),
      ],
    });
    const res = await svc.schedule(WS, 'u1', ['a', 'b'], NOW);
    expect(res).toEqual({ scheduled: ['a', 'b'], skipped: [] });
    expect(scheduling.schedule).toHaveBeenNthCalledWith(
      1,
      WS,
      'u1',
      expect.objectContaining({
        draftId: 'a',
        scheduledAt: FUTURE,
        channels: [
          {
            channelId: '7',
            platform: 'facebook',
            publishStatus: 'queued',
            retryCount: 0,
          },
        ],
        base: expect.objectContaining({ text: 'caption a' }),
      }),
    );
    expect(scheduling.schedule.mock.calls[1][2].scheduledAt).toBe(
      '2026-10-17T13:00:00.000Z',
    );
    expect(drafts.findById).toHaveBeenCalledWith(WS, 'a');
  });

  it('skips with the right reason and keeps going', async () => {
    const { svc, scheduling } = make({
      rows: [
        post('ok'),
        post('none', { targets: [] }),
        post('img', {
          mediaItems: [],
          targets: [{ channelId: '1', platform: 'instagram' }],
        }),
        post('late', {
          metadata: {
            source: 'first_week',
            firstWeekSlot: 2,
            suggestedAt: PAST,
          },
        }),
        post('done', { status: 'scheduled' }),
      ],
    });
    const res = await svc.schedule(
      WS,
      'u1',
      ['none', 'img', 'late', 'done', 'ok'],
      NOW,
    );
    expect(res.scheduled).toEqual(['ok']);
    expect(res.skipped).toEqual([
      { id: 'none', reason: 'no_targets' },
      { id: 'img', reason: 'needs_image' },
      { id: 'late', reason: 'past' },
      { id: 'done', reason: 'already_scheduled' },
    ]);
    expect(scheduling.schedule).toHaveBeenCalledTimes(1);
  });

  it("never touches an id that is not one of this workspace's first-week posts", async () => {
    const { svc, scheduling, drafts } = make({ rows: [post('mine')] });
    const res = await svc.schedule(
      WS,
      'u1',
      ['someone-elses-post', 'mine'],
      NOW,
    );
    expect(res.skipped).toEqual([
      { id: 'someone-elses-post', reason: 'not_found' },
    ]);
    expect(res.scheduled).toEqual(['mine']);
    expect(scheduling.schedule).toHaveBeenCalledTimes(1);
    expect(drafts.findById).not.toHaveBeenCalledWith(WS, 'someone-elses-post');
  });

  it('processes a repeated id once', async () => {
    const { svc, scheduling } = make({ rows: [post('a')] });
    const res = await svc.schedule(WS, 'u1', ['a', 'a', 'a'], NOW);
    expect(res.scheduled).toEqual(['a']);
    expect(scheduling.schedule).toHaveBeenCalledTimes(1);
  });

  it('reports queue_full when the channel queue ceiling refuses, and continues', async () => {
    const { svc, scheduling } = make({ rows: [post('a'), post('b')] });
    scheduling.schedule.mockRejectedValueOnce(
      new ForbiddenException('Scheduling queue full for channel 7'),
    );
    const res = await svc.schedule(WS, 'u1', ['a', 'b'], NOW);
    expect(res.skipped).toEqual([{ id: 'a', reason: 'queue_full' }]);
    expect(res.scheduled).toEqual(['b']);
  });

  it('reports past when the composer refuses a slot that slipped under 5 seconds', async () => {
    const { svc, scheduling } = make({ rows: [post('a')] });
    scheduling.schedule.mockRejectedValueOnce(
      new BadRequestException(
        'scheduledAt must be at least 5 seconds in the future',
      ),
    );
    const res = await svc.schedule(WS, 'u1', ['a'], NOW);
    expect(res.skipped).toEqual([{ id: 'a', reason: 'past' }]);
  });

  it('reports error for anything unexpected, and continues', async () => {
    const { svc, scheduling } = make({ rows: [post('a'), post('b')] });
    scheduling.schedule.mockRejectedValueOnce(new Error('db down'));
    const res = await svc.schedule(WS, 'u1', ['a', 'b'], NOW);
    expect(res.skipped).toEqual([{ id: 'a', reason: 'error' }]);
    expect(res.scheduled).toEqual(['b']);
  });
});

describe('FirstWeekService.unschedule', () => {
  it('cancels only first-week posts that are still scheduled', async () => {
    const { svc, scheduling } = make({
      rows: [
        post('s', { status: 'scheduled' }),
        post('d', { status: 'draft' }),
        post('p', { status: 'published' }),
      ],
    });
    const res = await svc.unschedule(WS, ['s', 'd', 'p', 'unknown', 's']);
    expect(res).toEqual({ unscheduled: ['s'] });
    expect(scheduling.cancel).toHaveBeenCalledTimes(1);
    expect(scheduling.cancel).toHaveBeenCalledWith(WS, 's');
  });
});
