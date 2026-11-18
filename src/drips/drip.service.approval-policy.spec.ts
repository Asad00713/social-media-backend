/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- test doubles are loosely typed */
import { ForbiddenException } from '@nestjs/common';

const writes: string[] = [];

jest.mock('../drizzle/db', () => {
  const mkChain = (rows: unknown[]): any =>
    new Proxy(function () {}, {
      get: (_t, prop) =>
        prop === 'then'
          ? (resolve: (v: unknown) => void) => resolve(rows)
          : () => mkChain(rows),
    });
  return {
    db: {
      select: () => mkChain([]),
      insert: () => {
        writes.push('insert');
        return mkChain([{ id: 'h1' }]);
      },
      update: () => {
        writes.push('update');
        return mkChain([{ id: 'row', status: 'approved' }]);
      },
    },
  };
});

import { DripService } from './drip.service';

const WS = 'ws1';
const ACTOR = 'member-1';
const POLICY_403 = {
  statusCode: 403,
  error: 'Forbidden',
  code: 'APPROVAL_REQUIRED_BY_POLICY',
  message:
    'Your workspace needs approval before posts go out. Ask an admin to launch this.',
};

function build(covers: boolean) {
  const coversAuthor = jest.fn(async (_ws: string, _user: string) => covers);
  const pol = {
    coversAuthor,
    assertMayActivate: async (ws: string, user: string) => {
      if (await coversAuthor(ws, user)) {
        throw new ForbiddenException(POLICY_403);
      }
    },
  };
  const svc = new DripService({ add: jest.fn() } as any, pol as any);
  jest
    .spyOn(svc, 'getDripCampaign')
    .mockResolvedValue({ id: 'd1', status: 'draft' } as any);
  jest.spyOn(svc, 'getDripPost').mockResolvedValue({
    id: 'dp1',
    dripCampaignId: 'd1',
    status: 'pending_review',
    generatedContent: 'AI text',
  } as any);
  const generate = jest
    .spyOn(svc as any, 'generateDripPosts')
    .mockResolvedValue(undefined);
  const scheduleAll = jest
    .spyOn(svc as any, 'scheduleAllDripJobs')
    .mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'recordHistory').mockResolvedValue(undefined);
  return { svc, coversAuthor, generate, scheduleAll };
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
});

describe('DripService and the workspace approval policy', () => {
  it('refuses a covered person activating, before any post or job exists', async () => {
    const { svc, coversAuthor, generate, scheduleAll } = build(true);
    expectPolicy403(await errorOf(svc.activateDripCampaign('d1', WS, ACTOR)));
    expect(coversAuthor).toHaveBeenCalledWith(WS, ACTOR);
    expect(generate).not.toHaveBeenCalled();
    expect(scheduleAll).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('refuses a covered person approving or edit-approving a drip post', async () => {
    const { svc } = build(true);
    expectPolicy403(await errorOf(svc.approveDripPost('dp1', WS, ACTOR)));
    expectPolicy403(
      await errorOf(
        svc.updateDripPostContent('dp1', WS, ACTOR, {
          generatedContent: 'mine',
        }),
      ),
    );
    expect(writes).toEqual([]);
  });

  it('lets an uncovered person activate and approve', async () => {
    const { svc, generate, scheduleAll } = build(false);
    await svc.activateDripCampaign('d1', WS, ACTOR);
    expect(generate).toHaveBeenCalled();
    expect(scheduleAll).toHaveBeenCalled();
    await svc.approveDripPost('dp1', WS, ACTOR);
    expect(writes).toContain('update');
  });

  it('does not gate creating a drip campaign (it starts as a draft)', async () => {
    const { svc, coversAuthor } = build(true);
    jest.spyOn(svc as any, 'validateChannels').mockResolvedValue(undefined);
    await svc.createDripCampaign(WS, ACTOR, {
      name: 'D',
      targetChannelIds: [7],
      occurrenceType: 'daily',
      publishTime: '10:00',
      startDate: '2030-01-01',
      endDate: '2030-01-03',
    } as any);
    expect(coversAuthor).not.toHaveBeenCalled();
    expect(writes).toContain('insert');
  });
});
