/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */
import { BadRequestException } from '@nestjs/common';
import { FirstWeekRunService } from './first-week-run.service';
import { LlmOutputError } from './lib/first-week-parse';
import type { SourceCandidate } from './lib/first-week-targets';

const WS = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-14T10:00:00Z'); // 15:00 in Karachi -> slots start 2026-10-15

const BRAND_JSON = JSON.stringify({
  sells: 'Small-batch coffee',
  voice: ['Warm', 'Local'],
  audience: 'Students nearby',
});
const draftJson = (n: number) =>
  JSON.stringify({ caption: `Caption ${n}`, imageQuery: `query ${n}` });

const candidate = (over: Partial<SourceCandidate> = {}): SourceCandidate => ({
  channelId: 7,
  platform: 'instagram',
  profilePictureUrl: 'https://pic/ig.png',
  backfilledAt: new Date('2026-10-14T09:00:00Z'),
  captions: ['one', 'two', 'three', 'four'],
  ...over,
});

class FakeRepo {
  log: string[] = [];
  profile: any = {
    workspaceId: WS,
    sells: null,
    voice: [],
    audience: null,
    source: 'posts',
    sourceChannelId: null,
    sourcePlatform: null,
    postsRead: 0,
    status: 'reading',
    draftedCount: 0,
    weekStartsOn: null,
    weekEndsAt: null,
    error: null,
  };
  workspace = {
    id: WS,
    timezone: 'Asia/Karachi',
    ownerId: OWNER,
    logo: null as string | null,
  };
  candidates: SourceCandidate[] = [candidate()];
  channels = [
    { id: 7, platform: 'instagram' },
    { id: 8, platform: 'tiktok' },
  ];
  drafts: any[] = [];
  logo: string | null = null;

  getProfile = jest.fn(async () => this.profile);
  getWorkspace = jest.fn(async () => this.workspace);
  listSourceCandidates = jest.fn(async () => this.candidates);
  getCaptionsForChannel = jest.fn(async () => ['sample one', 'sample two']);
  listPublishingChannels = jest.fn(async () => this.channels);
  setStatus = jest.fn(
    async (_w: string, status: string, error: string | null = null) => {
      this.log.push(status);
      this.profile = { ...this.profile, status, error };
    },
  );
  saveLearnedBrand = jest.fn(async (_w: string, v: any) => {
    this.profile = {
      ...this.profile,
      sells: v.brand.sells,
      voice: v.brand.voice,
      audience: v.brand.audience,
      source: 'posts',
      sourceChannelId: v.sourceChannelId,
      sourcePlatform: v.sourcePlatform,
      postsRead: v.postsRead,
    };
  });
  setWeek = jest.fn(async (_w: string, v: any) => {
    this.log.push('drafting');
    this.profile = {
      ...this.profile,
      status: 'drafting',
      weekStartsOn: v.weekStartsOn,
      weekEndsAt: v.weekEndsAt,
      error: null,
    };
  });
  listFirstWeekDrafts = jest.fn(async () => [...this.drafts]);
  insertDraft = jest.fn(async (row: any) => {
    if (this.drafts.some((d) => d.id === row.id)) return false;
    this.drafts.push({ ...row, scheduledAt: null });
    return true;
  });
  refreshDraftedCount = jest.fn(async () => undefined);
  setWorkspaceLogoIfEmpty = jest.fn(async (_w: string, url: string) => {
    this.logo = url;
  });
}

function harness(
  opts: { complete?: string[]; tokenOk?: (n: number) => boolean } = {},
) {
  const repo = new FakeRepo();
  const completions = [
    ...(opts.complete ??
      [BRAND_JSON, 1, 2, 3, 4, 5].map((x) =>
        typeof x === 'string' ? x : draftJson(x),
      )),
  ];
  const ai = {
    complete: jest.fn(async () => {
      const next = completions.shift();
      if (next === undefined) throw new Error('no more completions');
      return next;
    }),
  };
  let checks = 0;
  const deducted: string[] = [];
  const tokens = {
    checkTokens: jest.fn(async () => ({
      hasAccess: opts.tokenOk ? opts.tokenOk(++checks) : true,
    })),
    executeWithTokens: jest.fn(
      async (
        _w: string,
        _u: string,
        op: string,
        _p: unknown,
        _s: string,
        fn: () => Promise<{ result: unknown }>,
      ) => {
        const { result } = await fn();
        deducted.push(op);
        return { result, usage: {} };
      },
    ),
  };
  const stock = {
    find: jest.fn(async (q: string) => ({
      url: `https://img/${encodeURIComponent(q)}.jpg`,
      width: 10,
      height: 10,
      alt: q,
      credit: { provider: 'unsplash', author: 'A', pageUrl: 'https://u' },
    })),
  };
  const svc = new FirstWeekRunService(
    repo as any,
    tokens as any,
    ai as any,
    stock as any,
  );
  return { svc, repo, ai, tokens, stock, deducted };
}

describe('FirstWeekRunService', () => {
  describe('mode posts', () => {
    it('walks reading -> drafting -> ready and drafts 5 posts', async () => {
      const h = harness();
      const outcome = await h.svc.execute(
        { workspaceId: WS, mode: 'posts' },
        NOW,
      );
      expect(outcome).toBe('ready');
      expect(h.repo.log).toEqual(['reading', 'drafting', 'ready']);
      expect(h.repo.drafts).toHaveLength(5);
      expect(h.deducted).toEqual([
        'brand_learn',
        ...Array(5).fill('first_week_draft'),
      ]);
    });

    it('stores the brand and the source channel', async () => {
      const h = harness();
      await h.svc.execute({ workspaceId: WS, mode: 'posts' }, NOW);
      expect(h.repo.saveLearnedBrand).toHaveBeenCalledWith(WS, {
        brand: {
          sells: 'Small-batch coffee',
          voice: ['Warm', 'Local'],
          audience: 'Students nearby',
        },
        sourceChannelId: 7,
        sourcePlatform: 'instagram',
        postsRead: 4,
      });
    });

    it('writes drafts with the spec metadata, slot times in the workspace zone, and image-capable targets only', async () => {
      const h = harness();
      await h.svc.execute({ workspaceId: WS, mode: 'posts' }, NOW);
      const d0 = h.repo.drafts[0];
      expect(d0.status).toBe('draft');
      expect(d0.workspaceId).toBe(WS);
      expect(d0.createdById).toBe(OWNER);
      expect(d0.content).toBe('Caption 1');
      expect(d0.metadata).toMatchObject({
        source: 'first_week',
        firstWeekSlot: 0,
        suggestedAt: '2026-10-15T04:00:00.000Z', // 09:00 in Karachi
        imageCredit: {
          provider: 'unsplash',
          author: 'A',
          pageUrl: 'https://u',
        },
      });
      expect(d0.targets).toEqual([
        {
          channelId: '7',
          platform: 'instagram',
          publishStatus: 'queued',
          retryCount: 0,
        },
      ]);
      expect(d0.mediaItems[0]).toMatchObject({
        type: 'image',
        url: 'https://img/query%201.jpg',
      });
      expect(h.repo.drafts.map((d) => d.metadata.suggestedAt)).toEqual([
        '2026-10-15T04:00:00.000Z',
        '2026-10-16T13:00:00.000Z',
        '2026-10-17T04:00:00.000Z',
        '2026-10-18T13:00:00.000Z',
        '2026-10-19T04:00:00.000Z',
      ]);
      expect(h.repo.setWeek).toHaveBeenCalledWith(WS, {
        weekStartsOn: '2026-10-15',
        weekEndsAt: new Date('2026-10-19T04:00:00.000Z'),
      });
    });

    it('uses the caller as payer and author when the job names one', async () => {
      const h = harness();
      await h.svc.execute(
        { workspaceId: WS, mode: 'posts', userId: 'user-9' },
        NOW,
      );
      expect(h.tokens.executeWithTokens.mock.calls[0][1]).toBe('user-9');
      expect(h.repo.drafts[0].createdById).toBe('user-9');
    });

    it('sets the workspace logo from an Instagram source', async () => {
      const h = harness();
      await h.svc.execute({ workspaceId: WS, mode: 'posts' }, NOW);
      expect(h.repo.logo).toBe('https://pic/ig.png');
    });

    it('does not touch the logo for a non-Instagram source', async () => {
      const h = harness();
      h.repo.candidates = [
        candidate({
          platform: 'facebook',
          profilePictureUrl: 'https://pic/fb.png',
        }),
      ];
      await h.svc.execute({ workspaceId: WS, mode: 'posts' }, NOW);
      expect(h.repo.setWorkspaceLogoIfEmpty).not.toHaveBeenCalled();
    });

    it('stops at needs_description with fewer than 3 captions, spending nothing', async () => {
      const h = harness();
      h.repo.candidates = [candidate({ captions: ['one', 'two'] })];
      expect(await h.svc.execute({ workspaceId: WS, mode: 'posts' }, NOW)).toBe(
        'needs_description',
      );
      expect(h.repo.log).toEqual(['reading', 'needs_description']);
      expect(h.ai.complete).not.toHaveBeenCalled();
      expect(h.tokens.executeWithTokens).not.toHaveBeenCalled();
      expect(h.repo.drafts).toHaveLength(0);
    });

    it('stops at needs_description when no channel has posts at all', async () => {
      const h = harness();
      h.repo.candidates = [];
      expect(await h.svc.execute({ workspaceId: WS, mode: 'posts' }, NOW)).toBe(
        'needs_description',
      );
    });

    it('stops at no_tokens before learning when the pool cannot cover the brand', async () => {
      const h = harness({ tokenOk: () => false });
      expect(await h.svc.execute({ workspaceId: WS, mode: 'posts' }, NOW)).toBe(
        'no_tokens',
      );
      expect(h.repo.log).toEqual(['reading', 'no_tokens']);
      expect(h.ai.complete).not.toHaveBeenCalled();
    });

    it('keeps earlier drafts and reports no_tokens on a mid-week shortfall', async () => {
      // check 1 = brand_learn, checks 2-3 = drafts 0 and 1, check 4 = draft 2 -> short
      const h = harness({ tokenOk: (n) => n <= 3 });
      expect(await h.svc.execute({ workspaceId: WS, mode: 'posts' }, NOW)).toBe(
        'no_tokens',
      );
      expect(h.repo.drafts).toHaveLength(2);
      expect(h.repo.log).toEqual(['reading', 'drafting', 'no_tokens']);
      expect(h.repo.refreshDraftedCount).toHaveBeenCalled();
    });

    it('accepts a fenced brand answer', async () => {
      const fence = '`'.repeat(3);
      const h = harness({
        complete: [`${fence}json\n${BRAND_JSON}\n${fence}`, 1, 2, 3, 4, 5].map(
          (x) => (typeof x === 'string' ? x : draftJson(x)),
        ),
      });
      expect(await h.svc.execute({ workspaceId: WS, mode: 'posts' }, NOW)).toBe(
        'ready',
      );
    });

    it('an unparseable brand answer rejects and deducts nothing', async () => {
      const h = harness({ complete: ['Sorry, I cannot do that.'] });
      await expect(
        h.svc.execute({ workspaceId: WS, mode: 'posts' }, NOW),
      ).rejects.toBeInstanceOf(LlmOutputError);
      expect(h.deducted).toEqual([]);
      expect(h.repo.drafts).toHaveLength(0);
      expect(h.repo.profile.status).toBe('reading'); // the processor marks failed after the last retry
    });

    it('an over-long draft caption rejects, keeping the drafts already made and deducting nothing for it', async () => {
      const long = JSON.stringify({
        caption: 'x'.repeat(400),
        imageQuery: 'q',
      });
      const h = harness({ complete: [BRAND_JSON, draftJson(1), long] });
      await expect(
        h.svc.execute({ workspaceId: WS, mode: 'posts' }, NOW),
      ).rejects.toBeInstanceOf(LlmOutputError);
      expect(h.repo.drafts).toHaveLength(1);
      expect(h.deducted).toEqual(['brand_learn', 'first_week_draft']);
    });
  });

  describe('mode described', () => {
    const described = {
      sells: 'Bikes',
      voice: ['Bold'],
      audience: 'Commuters',
    };

    it('skips reading and learning: drafting -> ready, no brand charge', async () => {
      const h = harness({ complete: [1, 2, 3, 4, 5].map(draftJson) });
      h.repo.profile = {
        ...h.repo.profile,
        ...described,
        source: 'described',
        status: 'drafting',
      };
      expect(
        await h.svc.execute({ workspaceId: WS, mode: 'described' }, NOW),
      ).toBe('ready');
      expect(h.repo.log).toEqual(['drafting', 'ready']);
      expect(h.deducted).toEqual(Array(5).fill('first_week_draft'));
      expect(h.repo.listSourceCandidates).not.toHaveBeenCalled();
      expect(h.repo.getCaptionsForChannel).not.toHaveBeenCalled();
      expect(h.repo.setWorkspaceLogoIfEmpty).not.toHaveBeenCalled();
    });

    it('reports needs_description when asked to draft a brand that was never described', async () => {
      const h = harness();
      expect(
        await h.svc.execute({ workspaceId: WS, mode: 'described' }, NOW),
      ).toBe('needs_description');
      expect(h.ai.complete).not.toHaveBeenCalled();
    });

    it('saves a no-target draft when the workspace has no image-capable channel', async () => {
      const h = harness({ complete: [1, 2, 3, 4, 5].map(draftJson) });
      h.repo.profile = {
        ...h.repo.profile,
        ...described,
        source: 'described',
        status: 'drafting',
      };
      h.repo.channels = [{ id: 8, platform: 'tiktok' }];
      await h.svc.execute({ workspaceId: WS, mode: 'described' }, NOW);
      expect(h.repo.drafts.every((d) => d.targets.length === 0)).toBe(true);
    });
  });

  describe('idempotency and retries', () => {
    it('does nothing for a run whose profile is already ready (double enqueue)', async () => {
      const h = harness();
      h.repo.profile = { ...h.repo.profile, status: 'ready' };
      expect(await h.svc.execute({ workspaceId: WS, mode: 'posts' }, NOW)).toBe(
        'skipped',
      );
      expect(h.ai.complete).not.toHaveBeenCalled();
      expect(h.repo.setStatus).not.toHaveBeenCalled();
    });

    it('does nothing when the profile row is missing', async () => {
      const h = harness();
      h.repo.profile = null;
      expect(await h.svc.execute({ workspaceId: WS, mode: 'posts' }, NOW)).toBe(
        'skipped',
      );
    });

    it('does nothing when the workspace is gone', async () => {
      const h = harness();
      h.repo.workspace = null as any;
      expect(await h.svc.execute({ workspaceId: WS, mode: 'posts' }, NOW)).toBe(
        'skipped',
      );
    });

    it('only drafts the slots that are missing, and never re-charges the brand', async () => {
      const h = harness({ complete: [3, 4, 5].map(draftJson) });
      h.repo.profile = {
        ...h.repo.profile,
        sells: 'Coffee',
        voice: ['Warm'],
        audience: 'Everyone',
        status: 'drafting',
        sourceChannelId: 7,
        weekStartsOn: '2026-10-15',
      };
      h.repo.drafts = [0, 1].map((slot) => ({
        id: `existing-${slot}`,
        content: `old ${slot}`,
        metadata: {
          source: 'first_week',
          firstWeekSlot: slot,
          suggestedAt: 'x',
        },
      }));
      await h.svc.execute({ workspaceId: WS, mode: 'posts' }, NOW);
      expect(h.deducted).toEqual([
        'first_week_draft',
        'first_week_draft',
        'first_week_draft',
      ]);
      expect(h.repo.drafts.map((d) => d.metadata.firstWeekSlot).sort()).toEqual(
        [0, 1, 2, 3, 4],
      );
      expect(h.repo.listSourceCandidates).not.toHaveBeenCalled();
    });

    it('feeds already-drafted captions into the next prompt so drafts do not repeat', async () => {
      const h = harness({ complete: [1, 2, 3, 4, 5].map(draftJson) });
      h.repo.profile = {
        ...h.repo.profile,
        sells: 'Coffee',
        voice: ['Warm'],
        audience: 'Everyone',
        status: 'drafting',
        source: 'described',
      };
      await h.svc.execute({ workspaceId: WS, mode: 'described' }, NOW);
      const secondUserPrompt = (
        h.ai.complete.mock.calls[1] as unknown as string[]
      )[1];
      expect(secondUserPrompt).toContain('Caption 1');
    });

    it('two concurrent runs produce 5 drafts, not 10', async () => {
      const both = [1, 2, 3, 4, 5].map(draftJson);
      const h = harness({ complete: [...both, ...both] });
      h.repo.profile = {
        ...h.repo.profile,
        sells: 'Coffee',
        voice: ['Warm'],
        audience: 'Everyone',
        status: 'drafting',
        source: 'described',
      };
      const [a, b] = await Promise.all([
        h.svc.execute({ workspaceId: WS, mode: 'described' }, NOW),
        h.svc.execute({ workspaceId: WS, mode: 'described' }, NOW),
      ]);
      expect([a, b]).toEqual(['ready', 'ready']);
      expect(h.repo.drafts).toHaveLength(5);
      expect(new Set(h.repo.drafts.map((d) => d.id)).size).toBe(5);
      expect(h.deducted).toHaveLength(5); // the slot a run lost is never charged
    });

    it('a failed insert deducts nothing, and the retry pays for that slot exactly once', async () => {
      const h = harness({
        complete: [1, 2, 3, 4, 5].map(draftJson).concat(draftJson(1)),
      });
      h.repo.profile = {
        ...h.repo.profile,
        sells: 'Coffee',
        voice: ['Warm'],
        audience: 'Everyone',
        status: 'drafting',
        source: 'described',
      };
      const real = h.repo.insertDraft.getMockImplementation()!;
      h.repo.insertDraft.mockImplementationOnce(async () => {
        throw new Error('db down');
      });
      await expect(
        h.svc.execute({ workspaceId: WS, mode: 'described' }, NOW),
      ).rejects.toThrow('db down');
      expect(h.deducted).toEqual([]);
      h.repo.insertDraft.mockImplementation(real);
      expect(
        await h.svc.execute({ workspaceId: WS, mode: 'described' }, NOW),
      ).toBe('ready');
      expect(h.repo.drafts).toHaveLength(5);
      expect(h.deducted).toHaveLength(5);
    });

    it('a slot another run filled first is not charged and the loop continues', async () => {
      const h = harness({ complete: [1, 2, 3, 4, 5].map(draftJson) });
      h.repo.profile = {
        ...h.repo.profile,
        sells: 'Coffee',
        voice: ['Warm'],
        audience: 'Everyone',
        status: 'drafting',
        source: 'described',
      };
      h.repo.insertDraft.mockImplementationOnce(async () => false);
      expect(
        await h.svc.execute({ workspaceId: WS, mode: 'described' }, NOW),
      ).toBe('ready');
      expect(h.deducted).toHaveLength(4);
      expect(h.repo.drafts).toHaveLength(4);
    });

    it('a provider BadRequest inside the callback rejects (retries), is not no_tokens, and deducts nothing', async () => {
      const h = harness();
      h.repo.profile = {
        ...h.repo.profile,
        sells: 'Coffee',
        voice: ['Warm'],
        audience: 'Everyone',
        status: 'drafting',
        source: 'described',
      };
      h.ai.complete.mockRejectedValueOnce(
        new BadRequestException('AI is not configured'),
      );
      await expect(
        h.svc.execute({ workspaceId: WS, mode: 'described' }, NOW),
      ).rejects.toThrow('AI is not configured');
      expect(h.repo.profile.status).toBe('drafting');
      expect(h.deducted).toEqual([]);
    });

    it('brand_learn is not charged when saving the brand fails, so a retry never double-charges', async () => {
      const h = harness();
      h.repo.saveLearnedBrand.mockRejectedValueOnce(new Error('db down'));
      await expect(
        h.svc.execute({ workspaceId: WS, mode: 'posts' }, NOW),
      ).rejects.toThrow('db down');
      expect(h.deducted).toEqual([]);
    });

    it('a refusal before brand_learn ran ends as no_tokens', async () => {
      const h = harness();
      h.tokens.executeWithTokens.mockRejectedValueOnce(
        new BadRequestException('Insufficient tokens'),
      );
      expect(await h.svc.execute({ workspaceId: WS, mode: 'posts' }, NOW)).toBe(
        'no_tokens',
      );
      expect(h.repo.profile.status).toBe('no_tokens');
    });

    it('a token-looking error thrown INSIDE brand_learn propagates so it retries', async () => {
      const h = harness();
      h.repo.saveLearnedBrand.mockRejectedValueOnce(
        new BadRequestException('Insufficient tokens'),
      );
      await expect(
        h.svc.execute({ workspaceId: WS, mode: 'posts' }, NOW),
      ).rejects.toThrow('Insufficient tokens');
      expect(h.repo.profile.status).not.toBe('no_tokens');
    });

    it('a token race inside executeWithTokens ends as no_tokens, not a retry', async () => {
      const h = harness({ complete: [1, 2, 3, 4, 5].map(draftJson) });
      h.repo.profile = {
        ...h.repo.profile,
        sells: 'Coffee',
        voice: ['Warm'],
        audience: 'Everyone',
        status: 'drafting',
        source: 'described',
      };
      h.tokens.executeWithTokens.mockRejectedValueOnce(
        new BadRequestException('Insufficient tokens'),
      );
      expect(
        await h.svc.execute({ workspaceId: WS, mode: 'described' }, NOW),
      ).toBe('no_tokens');
      expect(h.repo.profile.status).toBe('no_tokens');
    });

    it('drafts on when the source channel was deleted mid-week (id nulled)', async () => {
      const h = harness({ complete: [1, 2, 3, 4, 5].map(draftJson) });
      h.repo.profile = {
        ...h.repo.profile,
        sells: 'Coffee',
        voice: ['Warm'],
        audience: 'Everyone',
        status: 'drafting',
        source: 'posts',
        sourceChannelId: null,
      };
      expect(await h.svc.execute({ workspaceId: WS, mode: 'posts' }, NOW)).toBe(
        'ready',
      );
      expect(h.repo.getCaptionsForChannel).not.toHaveBeenCalled();
    });

    it('a missing stock image leaves the draft with no media', async () => {
      const h = harness({
        complete: [BRAND_JSON, ...[1, 2, 3, 4, 5].map(draftJson)],
      });
      h.stock.find.mockResolvedValue(null as any);
      await h.svc.execute({ workspaceId: WS, mode: 'posts' }, NOW);
      expect(h.repo.drafts.every((d) => d.mediaItems.length === 0)).toBe(true);
      expect(h.repo.drafts[0].metadata.imageCredit).toBeUndefined();
    });

    it('markFailed records the failure, truncating a huge message', async () => {
      const h = harness();
      await h.svc.markFailed(WS, 'e'.repeat(2000));
      const [, status, error] = h.repo.setStatus.mock.calls[0];
      expect(status).toBe('failed');
      expect(String(error).length).toBeLessThanOrEqual(500);
    });
  });
});
