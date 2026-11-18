/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await -- test doubles are loosely typed */
import { ForbiddenException } from '@nestjs/common';

/** Every db write the services attempt, so a refusal can be shown to write nothing. */
const writes: string[] = [];
/** The row every select resolves to (set per test). */
let selectRow: Record<string, unknown> = {};

jest.mock('../drizzle/db', () => {
  const mkChain = (rows: () => unknown[]): any =>
    new Proxy(function () {}, {
      get: (_t, prop) =>
        prop === 'then'
          ? (resolve: (v: unknown) => void) => resolve(rows())
          : () => mkChain(rows),
    });
  return {
    db: {
      select: () => mkChain(() => [selectRow]),
      insert: () => {
        writes.push('insert');
        return mkChain(() => [{ id: 'new' }]);
      },
      update: () => {
        writes.push('update');
        return mkChain(() => [{ id: 'row' }]);
      },
      delete: () => {
        writes.push('delete');
        return mkChain(() => []);
      },
    },
  };
});

import { CampaignsService } from './campaigns.service';
import { EvergreenService } from './evergreen.service';

const WS = 'ws1';
const ACTOR = 'member-1';
const POLICY_403 = {
  statusCode: 403,
  error: 'Forbidden',
  code: 'APPROVAL_REQUIRED_BY_POLICY',
  message:
    'Your workspace needs approval before posts go out. Ask an admin to launch this.',
};

/** The real assertMayActivate over a coversAuthor double. */
function policy(covers: boolean) {
  const p = {
    coversAuthor: jest.fn(async (_ws: string, _user: string) => covers),
    assertMayActivate: async (ws: string, user: string) => {
      if (await p.coversAuthor(ws, user)) {
        throw new ForbiddenException(POLICY_403);
      }
    },
  };
  return p;
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

function expectPolicy403(err: unknown) {
  expect(err).toBeInstanceOf(ForbiddenException);
  expect((err as ForbiddenException).getResponse()).toEqual(POLICY_403);
}

beforeEach(() => {
  writes.length = 0;
  selectRow = {};
});

describe('CampaignsService and the workspace approval policy', () => {
  function build(covers: boolean, type = 'bulk') {
    const publishing = {
      materializeAndEnqueue: jest.fn(async () => ({ postId: 'p', jobId: 'j' })),
      cancelSlotJob: jest.fn(async () => undefined),
    };
    const evergreen = {
      launch: jest.fn(async () => ({ id: 'c1' })),
      resume: jest.fn(async () => ({ id: 'c1' })),
    };
    const pol = policy(covers);
    const svc = new CampaignsService(
      publishing as any,
      evergreen as any,
      pol as any,
    );
    jest.spyOn(svc, 'getOne').mockResolvedValue({ id: 'c1', type } as any);
    return { svc, publishing, evergreen, pol };
  }

  it.each(['bulk', 'drip', 'evergreen'])(
    'refuses a covered person launching a %s campaign before anything is written',
    async (type) => {
      const { svc, publishing, evergreen, pol } = build(true, type);
      expectPolicy403(await errorOf(svc.launch(WS, 'c1', ACTOR)));
      expect(pol.coversAuthor).toHaveBeenCalledWith(WS, ACTOR);
      expect(publishing.materializeAndEnqueue).not.toHaveBeenCalled();
      expect(evergreen.launch).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    },
  );

  it('refuses a covered person resuming a campaign', async () => {
    const { svc, publishing, evergreen } = build(true, 'evergreen');
    expectPolicy403(await errorOf(svc.resume(WS, 'c1', ACTOR)));
    expect(evergreen.resume).not.toHaveBeenCalled();
    expect(publishing.materializeAndEnqueue).not.toHaveBeenCalled();
  });

  it('lets an uncovered person launch and resume', async () => {
    const { svc, evergreen } = build(false, 'evergreen');
    await svc.launch(WS, 'c1', ACTOR);
    await svc.resume(WS, 'c1', ACTOR);
    expect(evergreen.launch).toHaveBeenCalled();
    expect(evergreen.resume).toHaveBeenCalled();
  });

  const slot = {
    id: 's1',
    date: '2030-01-01',
    channelId: '7',
    time: '10:00',
    slotStatus: 'scheduled',
    content: { mode: 'manual', caption: 'old' },
    jobId: 'j1',
    postId: 'p1',
    // The campaign status read shares the stubbed row.
    status: 'active',
  };

  it('refuses a covered content edit of a launched, scheduled slot', async () => {
    const { svc, publishing } = build(true);
    selectRow = slot;
    expectPolicy403(
      await errorOf(
        svc.updateEvent(
          WS,
          'c1',
          {
            date: slot.date,
            channelId: slot.channelId,
            patch: { caption: 'new words' },
          } as any,
          ACTOR,
        ),
      ),
    );
    expect(publishing.cancelSlotJob).not.toHaveBeenCalled();
    expect(publishing.materializeAndEnqueue).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('does not gate an edit of a slot on a draft campaign', async () => {
    const { svc, pol } = build(true);
    selectRow = { ...slot, status: 'draft', slotStatus: 'pending' };
    const err = await errorOf(
      svc.updateEvent(
        WS,
        'c1',
        {
          date: slot.date,
          channelId: slot.channelId,
          patch: { caption: 'x' },
        } as any,
        ACTOR,
      ),
    );
    expect((err as any)?.response?.code).not.toBe(
      'APPROVAL_REQUIRED_BY_POLICY',
    );
    expect(pol.coversAuthor).not.toHaveBeenCalled();
  });
});

describe('EvergreenService and the workspace approval policy', () => {
  function build(covers: boolean, status: string) {
    const pol = policy(covers);
    const svc = new EvergreenService(
      {} as any, // CampaignPublishingService
      { add: jest.fn() } as any, // rotation queue
      { generateVariations: jest.fn() } as any, // GroqService
      { executeWithTokens: jest.fn() } as any, // AiTokenService
      pol as any,
    );
    jest
      .spyOn(svc as any, 'loadOwnedCampaign')
      .mockResolvedValue({ id: 'c1', status });
    jest.spyOn(svc as any, 'loadOwnedCategory').mockResolvedValue({ id: 'k1' });
    jest
      .spyOn(svc as any, 'loadOwnedPost')
      .mockResolvedValue({
        id: 'e1',
        variations: [],
        content: { caption: 'c' },
      });
    jest.spyOn(svc, 'assembleEvergreen').mockResolvedValue({ id: 'c1' } as any);
    return { svc, pol };
  }

  const content = { caption: 'Pool post', media: [] };

  it('refuses a covered person adding to, editing or varying a live pool', async () => {
    const { svc } = build(true, 'active');
    expectPolicy403(
      await errorOf(svc.addPost(WS, 'c1', 'k1', { content } as any, ACTOR)),
    );
    expectPolicy403(
      await errorOf(
        svc.updatePost(WS, 'c1', 'k1', 'e1', { content } as any, ACTOR),
      ),
    );
    expectPolicy403(
      await errorOf(
        svc.addVariation(WS, 'c1', 'k1', 'e1', { caption: 'v' } as any, ACTOR),
      ),
    );
    expectPolicy403(
      await errorOf(svc.generateVariations(WS, ACTOR, 'c1', 'k1', 'e1')),
    );
    expect(writes).toEqual([]);
  });

  it('leaves a draft pool and a schedule-only edit alone', async () => {
    const draft = build(true, 'draft');
    await draft.svc.addPost(WS, 'c1', 'k1', { content } as any, ACTOR);
    expect(writes).toEqual(['insert']);

    const live = build(true, 'active');
    selectRow = { id: 'e1' };
    await live.svc.updatePost(
      WS,
      'c1',
      'k1',
      'e1',
      { minGapHours: 4 } as any,
      ACTOR,
    );
    expect(live.pol.coversAuthor).not.toHaveBeenCalled();
  });

  it('lets an uncovered person add to a live pool', async () => {
    const { svc } = build(false, 'active');
    await svc.addPost(WS, 'c1', 'k1', { content } as any, ACTOR);
    expect(writes).toEqual(['insert']);
  });
});
