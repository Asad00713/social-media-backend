/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- test doubles are loosely typed */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { getTableName } from 'drizzle-orm';
import {
  PostDraftsService,
  READY_PREVIEW_MAX,
  readyPreview,
} from './post-drafts.service';

const WS = 'ws-1';
const POST = 'post-1';
const OWNER = 'owner-1';
const ACTOR = 'actor-1';
const MEMBER = 'member-1';
const GUEST = 'guest-1';

interface World {
  post: Record<string, any> | null;
  invitations: Array<{ id: string; role: string; status: string }>;
}

/**
 * A fake drizzle db. Reads answer by table name; the post update honours the
 * "ready_at IS [NOT] NULL" guard by checking the state it is asked to change.
 */
function makeDb(world: World) {
  const sets: Array<Record<string, unknown>> = [];
  const history: Array<Record<string, unknown>> = [];
  const db: any = {
    select: () => ({
      from: (table: any) => {
        const name = getTableName(table);
        const rows = () => {
          if (name === 'posts') return world.post ? [world.post] : [];
          if (name === 'workspace') return [{ id: OWNER }];
          if (name === 'workspace_invitations') return world.invitations;
          if (name === 'users') return [{ name: 'Sara', email: 'sara@x.test' }];
          return [];
        };
        const chain: any = { where: () => chain };
        chain.then = (res: any, rej: any) =>
          Promise.resolve(rows()).then(res, rej);
        return chain;
      },
    }),
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        sets.push(payload);
        return {
          where: () => ({
            returning: () => {
              const wantReady = payload.readyById !== null;
              const isReady = world.post?.readyAt != null;
              if (wantReady === isReady) return Promise.resolve([]);
              world.post!.readyAt = wantReady ? new Date() : null;
              return Promise.resolve([{ id: POST }]);
            },
          }),
        };
      },
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        history.push(v);
        return Promise.resolve();
      },
    }),
  };
  return { db, sets, history };
}

function make(world: World, draftReady = jest.fn().mockResolvedValue({})) {
  const { db, sets, history } = makeDb(world);
  const planner = { getOne: jest.fn().mockResolvedValue({ id: POST }) };
  const svc = new PostDraftsService(db, planner as any, { draftReady } as any);
  return { svc, sets, history, draftReady, planner };
}

const draft = (over: Record<string, unknown> = {}): World => ({
  post: {
    id: POST,
    status: 'draft',
    createdById: MEMBER,
    content: 'Launch day',
    readyAt: null,
    ...over,
  },
  invitations: [],
});

describe('PostDraftsService.setReady', () => {
  it('404s a post that is not in the workspace', async () => {
    const { svc } = make({ post: null, invitations: [] });
    await expect(
      svc.setReady(WS, POST, ACTOR, 'MEMBER', true),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('400s a post that is not a draft', async () => {
    const { svc } = make(draft({ status: 'scheduled' }));
    await expect(svc.setReady(WS, POST, ACTOR, 'MEMBER', true)).rejects.toThrow(
      new BadRequestException('Only drafts can be marked ready'),
    );
  });

  it('refuses a Guest on a draft someone else made', async () => {
    const { svc, sets } = make(draft({ createdById: MEMBER }));
    await expect(
      svc.setReady(WS, POST, GUEST, 'GUEST', true),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(sets).toHaveLength(0);
  });

  it('lets a Guest mark their own draft', async () => {
    const { svc } = make(draft({ createdById: GUEST }));
    await expect(svc.setReady(WS, POST, GUEST, 'GUEST', true)).resolves.toEqual(
      { id: POST },
    );
  });

  it('lets a Member mark any draft', async () => {
    const { svc } = make(draft({ createdById: GUEST }));
    await expect(
      svc.setReady(WS, POST, MEMBER, 'MEMBER', true),
    ).resolves.toEqual({ id: POST });
  });

  it('never writes updatedAt, for ready true or false', async () => {
    const { svc, sets } = make(draft());
    await svc.setReady(WS, POST, ACTOR, 'MEMBER', true);
    await svc.setReady(WS, POST, ACTOR, 'MEMBER', false);
    expect(sets).toHaveLength(2);
    for (const s of sets) expect(s).not.toHaveProperty('updatedAt');
    expect(sets[1]).toEqual({ readyAt: null, readyById: null });
    expect(sets[0]).toHaveProperty('readyById', ACTOR);
  });

  it('records marked_ready / unmarked_ready history with the actor', async () => {
    const { svc, history } = make(draft());
    await svc.setReady(WS, POST, ACTOR, 'MEMBER', true);
    await svc.setReady(WS, POST, ACTOR, 'MEMBER', false);
    expect(history.map((h) => [h.action, h.performedById])).toEqual([
      ['marked_ready', ACTOR],
      ['unmarked_ready', ACTOR],
    ]);
  });

  it('notifies the owner and MEMBER+, not a Guest and not the caller', async () => {
    const world = draft();
    // The fake returns every invitation row regardless of the service's
    // role/status filter, so the GUEST row proves nothing here; the filter is
    // proven in the DB spec. What this checks: dedupe + caller exclusion.
    world.invitations = [
      { id: MEMBER, role: 'MEMBER', status: 'ACCEPTED' },
      { id: ACTOR, role: 'ADMIN', status: 'ACCEPTED' },
      { id: OWNER, role: 'ADMIN', status: 'ACCEPTED' },
    ];
    const { svc, draftReady } = make(world);
    await svc.setReady(WS, POST, ACTOR, 'ADMIN', true);
    const ids = draftReady.mock.calls.map((c) => c[0]).sort();
    expect(ids).toEqual([MEMBER, OWNER].sort());
    expect(draftReady.mock.calls[0][1]).toMatchObject({
      workspaceId: WS,
      postId: POST,
      markedByName: 'Sara',
      preview: 'Launch day',
    });
  });

  it('does not notify the owner of their own click', async () => {
    const { svc, draftReady } = make(draft());
    await svc.setReady(WS, POST, OWNER, 'ADMIN', true);
    expect(draftReady).not.toHaveBeenCalled();
  });

  it('a second ready:true changes nothing and notifies nobody again', async () => {
    const { svc, draftReady, history } = make(draft());
    await svc.setReady(WS, POST, ACTOR, 'MEMBER', true);
    expect(draftReady).toHaveBeenCalledTimes(1); // the owner
    await svc.setReady(WS, POST, ACTOR, 'MEMBER', true);
    expect(draftReady).toHaveBeenCalledTimes(1);
    expect(history).toHaveLength(1);
  });

  it('does not fail when a notification throws', async () => {
    const draftReady = jest.fn().mockRejectedValue(new Error('push down'));
    const { svc } = make(draft(), draftReady);
    await expect(
      svc.setReady(WS, POST, ACTOR, 'MEMBER', true),
    ).resolves.toEqual({ id: POST });
    expect(draftReady).toHaveBeenCalled();
  });

  it('truncates a long post to an 80 character preview', async () => {
    const { svc, draftReady } = make(draft({ content: 'word '.repeat(100) }));
    await svc.setReady(WS, POST, ACTOR, 'MEMBER', true);
    const { preview } = draftReady.mock.calls[0][1];
    expect(preview.length).toBeLessThanOrEqual(READY_PREVIEW_MAX);
    expect(preview.endsWith('…')).toBe(true);
  });
});

describe('readyPreview', () => {
  it('keeps a short post and collapses whitespace', () => {
    expect(readyPreview('  Hello\n\nworld ')).toBe('Hello world');
  });
  it('cuts to exactly 80 with an ellipsis', () => {
    const out = readyPreview('x'.repeat(200));
    expect(out).toHaveLength(80);
    expect(out.endsWith('…')).toBe(true);
  });
  it('does not touch an 80 character post', () => {
    expect(readyPreview('y'.repeat(80))).toBe('y'.repeat(80));
  });
  it('names an empty draft', () => {
    expect(readyPreview(null)).toBe('Untitled draft');
  });
});
