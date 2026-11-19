/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await -- test doubles are loosely typed */
import { BadRequestException } from '@nestjs/common';

const writes: { inserts: any[]; sets: any[] } = { inserts: [], sets: [] };

jest.mock('../../drizzle/db', () => {
  const mkChain = (rows: unknown[]): any =>
    new Proxy(function () {}, {
      get: (_t, prop) =>
        prop === 'then'
          ? (resolve: (v: unknown) => void) => resolve(rows)
          : () => mkChain(rows),
    });
  const dbFake: Record<string, unknown> = {
    insert: () => ({
      values: (v: unknown) => {
        writes.inserts.push(v);
        return mkChain([{ id: 'p-new', status: 'draft' }]);
      },
    }),
    select: () => mkChain([{ id: 'p1', status: 'draft' }]),
    update: () => ({
      set: (v: unknown) => {
        writes.sets.push(v);
        return mkChain([{ id: 'p1', status: 'draft' }]);
      },
    }),
    delete: () => mkChain([]),
    /**
     * `createPost` writes the post and its `post_history` row in one
     * transaction, so the fake has to offer one. It runs the callback with
     * ITSELF as `tx`, so writes inside land in the same `writes` capture the
     * assertions read - a `tx` that swallowed them would make this spec
     * green while the post was never recorded.
     */
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(dbFake),
    execute: () => mkChain([]),
  };
  return { db: dbFake };
});

import { PostService } from './post.service';
import { contentFingerprint, newApprovalRequest } from '../lib/draft-approval';
import { buildDuplicate } from '../lib/duplicate-post';

const WS = 'ws1';

function makeService(existing: Record<string, unknown>, policyCovers = false) {
  const noop = async () => undefined;
  const svc = new PostService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { emit: jest.fn() } as any,
    { syncPost: noop, loadPostLinks: async () => [] } as any,
    {} as any,
    { enforceQueueLimit: noop } as any,
    { send: jest.fn() } as any, // PostReminderService
    { onPublishOutcome: jest.fn(async () => undefined) } as any, // PublishFailureNotifier
    {} as any, // StrandedPostSweeperService (main, #234)
    { coversAuthor: jest.fn(async () => policyCovers) } as any, // ApprovalPolicyService
  );
  jest.spyOn(svc, 'getPost').mockResolvedValue(existing as any);
  jest.spyOn(svc as any, 'validateChannels').mockResolvedValue([]);
  jest.spyOn(svc as any, 'recordHistory').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'cancelPublishJobs').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'syncCalendarForPost').mockReturnValue(undefined);
  jest.spyOn(svc as any, 'schedulePublishJob').mockResolvedValue('job-1');
  return svc;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return ((e as BadRequestException).getResponse() as { code: string }).code;
  }
  throw new Error('expected a refusal');
}

const base = {
  id: 'p1',
  createdById: 'u1',
  jobId: null,
  content: 'Iced latte',
  mediaItems: [],
  platformContent: {},
  targets: [{ channelId: '7', platform: 'x', status: 'draft' }],
};

const pending = (status = 'draft') => ({
  ...base,
  status,
  metadata: { title: 'T', approval: newApprovalRequest('u1') },
});

const approved = (status = 'draft') => ({
  ...base,
  status,
  metadata: {
    title: 'T',
    approval: {
      ...newApprovalRequest('u1'),
      approvedById: 'admin',
      approvedAt: '2026-11-01T00:00:00.000Z',
      approvedFingerprint: contentFingerprint({
        ...base,
        metadata: { title: 'T' },
      }),
    },
  },
});

const later = () => new Date(Date.now() + 3_600_000);

beforeEach(() => {
  writes.inserts.length = 0;
  writes.sets.length = 0;
});

describe('PostService and "Needs approval"', () => {
  it('refuses to schedule a draft whose approval is pending', async () => {
    const svc = makeService(pending());
    expect(
      await codeOf(
        svc.updatePost(
          'p1',
          WS,
          'u1',
          { scheduledAt: later() } as any,
          'MEMBER',
        ),
      ),
    ).toBe('APPROVAL_REQUIRED');
    expect(writes.sets).toHaveLength(0);
  });

  it('refuses an edit to an approved, scheduled post that the grant does not cover', async () => {
    const svc = makeService(approved('scheduled'));
    expect(
      await codeOf(
        svc.updatePost('p1', WS, 'u1', { content: 'edited' } as any, 'MEMBER'),
      ),
    ).toBe('APPROVAL_STALE');
  });

  it('schedules an approved draft and keeps the approval on the row', async () => {
    const svc = makeService(approved());
    await svc.updatePost(
      'p1',
      WS,
      'u1',
      { scheduledAt: later() } as any,
      'MEMBER',
    );
    const set = writes.sets.find((s) => s.metadata);
    expect(set.metadata.approval.approvedById).toBe('admin');
    expect(set.metadata.title).toBe('T');
  });

  it("a metadata-only edit (a legacy row's first comment) withdraws the grant", async () => {
    const svc = makeService(approved());
    await svc.updatePost(
      'p1',
      WS,
      'u1',
      { metadata: { title: 'T', firstComment: 'buy now' } } as any,
      'MEMBER',
    );
    const set = writes.sets.find((s) => s.metadata);
    expect(set.metadata.firstComment).toBe('buy now');
    expect(set.metadata.approval).toMatchObject({
      approvedById: null,
      approvedAt: null,
    });
  });

  it('refuses to schedule an approved draft whose metadata changed in the same request', async () => {
    const svc = makeService(approved());
    expect(
      await codeOf(
        svc.updatePost(
          'p1',
          WS,
          'u1',
          {
            scheduledAt: later(),
            metadata: { title: 'T', poll: { options: ['a', 'b'] } },
          } as any,
          'MEMBER',
        ),
      ),
    ).toBe('APPROVAL_STALE');
  });

  it('a draft edit withdraws the grant and a client cannot write one', async () => {
    const svc = makeService(approved());
    await svc.updatePost(
      'p1',
      WS,
      'u1',
      {
        content: 'edited',
        metadata: {
          title: 'T2',
          approval: { required: false },
        },
      } as any,
      'MEMBER',
    );
    const set = writes.sets.find((s) => s.metadata);
    expect(set.metadata.title).toBe('T2');
    expect(set.metadata.approval).toMatchObject({
      required: true,
      requestedById: 'u1',
      approvedAt: null,
    });
  });

  it('a post without approval cannot be handed one through metadata', async () => {
    const svc = makeService({ ...base, status: 'draft', metadata: {} });
    await svc.updatePost(
      'p1',
      WS,
      'u1',
      { metadata: { title: 'x', approval: { required: true } } } as any,
      'MEMBER',
    );
    const set = writes.sets.find((s) => s.metadata);
    expect(set.metadata).toEqual({ title: 'x' });
  });

  it('createPost drops a client-supplied approval', async () => {
    const svc = makeService({});
    await svc.createPost(
      WS,
      'u1',
      {
        content: 'x',
        targetChannelIds: [],
        metadata: { title: 'x', approval: { required: true } },
      } as any,
      'MEMBER',
    );
    expect(writes.inserts[0].metadata).toEqual({ title: 'x' });
  });

  it('a person cannot publish a pending post; the scheduler is not stopped here', async () => {
    const svc = makeService(pending('scheduled'));
    expect(await codeOf(svc.publishPost('p1', WS, 'u1'))).toBe(
      'APPROVAL_REQUIRED',
    );
    // Past the guard on the scheduler path (it fails later on the stub db).
    await expect(
      svc.publishPost('p1', WS, 'u1', { triggeredBy: 'scheduler' }),
    ).rejects.not.toMatchObject({
      response: { code: 'APPROVAL_REQUIRED' },
    });
  });
});

/** The refusal code a call ends with, or null when it is not refused by code. */
async function outcomeCode(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    const res = (e as { getResponse?: () => unknown }).getResponse?.();
    return (res as { code?: string } | undefined)?.code ?? null;
  }
}

describe('PostService and the workspace approval policy (covered author)', () => {
  const plain = (status = 'draft') => ({
    ...base,
    status,
    metadata: { title: 'T' },
  });

  it('refuses createPost with a time, before anything is written', async () => {
    const svc = makeService({}, true);
    expect(
      await codeOf(
        svc.createPost(
          WS,
          'u1',
          { content: 'x', targetChannelIds: [], scheduledAt: later() } as any,
          'MEMBER',
        ),
      ),
    ).toBe('APPROVAL_REQUIRED');
    expect(writes.inserts).toHaveLength(0);
  });

  it('still lets createPost save a draft', async () => {
    const svc = makeService({}, true);
    await svc.createPost(
      WS,
      'u1',
      { content: 'x', targetChannelIds: [] } as any,
      'MEMBER',
    );
    expect(writes.inserts).toHaveLength(1);
  });

  it('refuses updatePost turning a draft with no approval into a scheduled post', async () => {
    const svc = makeService(plain('draft'), true);
    expect(
      await codeOf(
        svc.updatePost(
          'p1',
          WS,
          'u1',
          { scheduledAt: later() } as any,
          'MEMBER',
        ),
      ),
    ).toBe('APPROVAL_REQUIRED');
    expect(writes.sets).toHaveLength(0);
  });

  it('refuses a content change to a scheduled post with no approval', async () => {
    const svc = makeService(plain('scheduled'), true);
    expect(
      await codeOf(
        svc.updatePost('p1', WS, 'u1', { content: 'edited' } as any, 'MEMBER'),
      ),
    ).toBe('APPROVAL_REQUIRED');
    expect(writes.sets).toHaveLength(0);
  });

  it('lets a pure time move of a scheduled post through (calendar pull-sync)', async () => {
    const svc = makeService(plain('scheduled'), true);
    await svc.updatePost(
      'p1',
      WS,
      'u1',
      { scheduledAt: later() } as any,
      'MEMBER',
    );
    expect(writes.sets.length).toBeGreaterThan(0);
  });

  it('a time move that also changes metadata (thread, firstComment, title) is not pure', async () => {
    for (const metadata of [
      { title: 'T', firstComment: 'Link in bio' },
      { title: 'T', thread: [{ text: 'and another thing' }] },
      { title: 'Retitled' },
    ]) {
      const svc = makeService(plain('scheduled'), true);
      expect(
        await codeOf(
          svc.updatePost(
            'p1',
            WS,
            'u1',
            { scheduledAt: later(), metadata } as any,
            'MEMBER',
          ),
        ),
      ).toBe('APPROVAL_REQUIRED');
      // No time at all: still a change to a scheduled post.
      expect(
        await codeOf(
          svc.updatePost('p1', WS, 'u1', { metadata } as any, 'MEMBER'),
        ),
      ).toBe('APPROVAL_REQUIRED');
    }
    expect(writes.sets).toHaveLength(0);
  });

  it('a time move that resends the stored metadata unchanged is still pure', async () => {
    const svc = makeService(plain('scheduled'), true);
    await svc.updatePost(
      'p1',
      WS,
      'u1',
      { scheduledAt: later(), metadata: { title: 'T' } } as any,
      'MEMBER',
    );
    expect(writes.sets.length).toBeGreaterThan(0);
  });

  it("refuses a person's Publish now, but not a drip occurrence (trigger scheduled)", async () => {
    const svc = makeService(plain('draft'), true);
    expect(await codeOf(svc.publishPost('p1', WS, 'u1'))).toBe(
      'APPROVAL_REQUIRED',
    );
    expect(
      await outcomeCode(
        svc.publishPost('p1', WS, 'u1', { trigger: 'scheduled' }),
      ),
    ).not.toBe('APPROVAL_REQUIRED');
  });

  it('never refuses an author the policy does not cover', async () => {
    const svc = makeService(plain('draft'), false);
    await svc.updatePost(
      'p1',
      WS,
      'u1',
      { scheduledAt: later() } as any,
      'ADMIN',
    );
    expect(writes.sets.length).toBeGreaterThan(0);
    expect(await outcomeCode(svc.publishPost('p1', WS, 'u1'))).not.toBe(
      'APPROVAL_REQUIRED',
    );
  });
});

describe('buildDuplicate and approvals', () => {
  it('a copy keeps the request in the copier name, never the grant', () => {
    const copy = buildDuplicate(approved() as any, 'u9');
    expect((copy.metadata as any).approval).toMatchObject({
      required: true,
      requestedById: 'u9',
      approvedById: null,
      approvedAt: null,
      approvedFingerprint: null,
    });
  });

  it('a copy of a post without approval has none', () => {
    const copy = buildDuplicate({ ...base, metadata: {} } as any, 'u9');
    expect(copy.metadata).not.toHaveProperty('approval');
  });

  it('a copy never carries a leftover approval object that is not a request', () => {
    const copy = buildDuplicate(
      {
        ...base,
        metadata: { approval: { required: false, approvedAt: 'x' } },
      } as any,
      'u9',
    );
    expect(copy.metadata).not.toHaveProperty('approval');
  });
});
