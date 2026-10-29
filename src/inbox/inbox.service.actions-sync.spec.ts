// InboxService imports `db` as a module-level singleton, so jest.mock the
// module with a scripted chainable fake. Every `update` is logged in call
// order (set keys + rendered WHERE), and so is every `syncThread` call, which
// lets a row assert "the author stamp lands BEFORE the sync".
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

interface UpdateLog {
  kind: 'update';
  setKeys: string[];
  setValues: Record<string, unknown>;
  where: string;
  params: unknown[];
}
interface SyncLog {
  kind: 'sync';
}
const log: Array<UpdateLog | SyncLog> = [];
interface SelectLog {
  keys: string[];
  where: string;
  params: unknown[];
}
const selectLog: SelectLog[] = [];
interface Script {
  item: Record<string, unknown>;
  channel: Record<string, unknown>;
  user: Record<string, unknown> | null;
  updated: Array<Record<string, unknown>>;
  selected: Array<Record<string, unknown>>;
  // Result of a select, by its projected column names. The collision query
  // projects `text`; the DM window query projects `at`.
  onSelect: (keys: string[]) => Array<Record<string, unknown>>;
  // Runs when a reply marks its target replied; may delay it (a slow UPDATE).
  onRepliedUpdate: ((values: Record<string, unknown>) => Promise<void>) | null;
}
const script: Script = {
  item: {},
  channel: {},
  user: null,
  updated: [],
  selected: [],
  onSelect: () => script.selected,
  onRepliedUpdate: null,
};

function chain(
  result: () => unknown,
  onCall?: (n: string, a: unknown[]) => void,
) {
  const c: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (res: (v: unknown) => unknown) => res(result());
        }
        return (...args: unknown[]) => {
          onCall?.(prop, args);
          return c;
        };
      },
    },
  );
  return c;
}

jest.mock('../drizzle/db', () => ({
  db: {
    select: jest.fn((fields?: object) => {
      const entry: SelectLog = {
        keys: Object.keys(fields ?? {}),
        where: '',
        params: [],
      };
      selectLog.push(entry);
      return chain(
        () => script.onSelect(entry.keys),
        (name, args) => {
          if (name === 'where') {
            const q = new PgDialect().sqlToQuery(args[0] as SQL);
            entry.where = q.sql;
            entry.params = q.params;
          }
        },
      );
    }),
    update: jest.fn(() => {
      const entry: UpdateLog = {
        kind: 'update',
        setKeys: [],
        setValues: {},
        where: '',
        params: [],
      };
      log.push(entry);
      return chain(
        () =>
          entry.setKeys.includes('repliedAt') && script.onRepliedUpdate
            ? script.onRepliedUpdate(entry.setValues).then(() => script.updated)
            : script.updated,
        (name, args) => {
          if (name === 'set') {
            entry.setKeys = Object.keys(args[0] as object);
            entry.setValues = args[0] as Record<string, unknown>;
          }
          if (name === 'where') {
            const q = new PgDialect().sqlToQuery(args[0] as SQL);
            entry.where = q.sql;
            entry.params = q.params;
          }
        },
      );
    }),
    query: {
      inboxItems: { findFirst: jest.fn(() => Promise.resolve(script.item)) },
      socialMediaChannels: {
        findFirst: jest.fn(() => Promise.resolve(script.channel)),
      },
      users: { findFirst: jest.fn(() => Promise.resolve(script.user)) },
      whatsappMessageTemplates: {
        findFirst: jest.fn(() => Promise.resolve({ status: 'APPROVED' })),
      },
    },
  },
}));

import { InboxService } from './inbox.service';
import type { SendOptions } from './inbox.service';
import { FakeSendLockRedis } from './testing/fake-send-lock-redis';
import { SendLockService } from './conversations/services/send-lock.service';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  ChannelNotConnectedError,
  InboxSendError,
} from './conversations/lib/send-error';
import { DEFAULT_INBOX_SETTINGS } from './conversations/services/inbox-settings.service';
import type { SyncIntent } from './conversations/lib/lifecycle';

const WS = 'ws-1';
const USER = 'u1';
const CH = 7;
const AT = new Date('2026-10-26T10:00:00.000Z');
const CREATED = {
  platformItemId: 'new1',
  platformParentId: null,
  conversationId: 'conv',
  text: 'hello',
  platformCreatedAt: AT,
};

const ROW = {
  id: 'row-1',
  workspaceId: WS,
  channelId: CH,
  platform: 'instagram',
  type: 'comment',
  platformItemId: 'c1',
  platformParentId: null,
  platformPostId: 'p1',
  conversationId: null,
  threadKey: `${CH}:p1`,
  fromMe: true,
  status: 'unread',
  metadata: {},
  ourPostId: null,
};
const DM_ROW = {
  ...ROW,
  type: 'dm',
  platformPostId: null,
  conversationId: 'conv',
  threadKey: `${CH}:conv`,
};
const NEW_ROW = { ...ROW, id: 'new-row', platformItemId: 'new1' };
const NEW_DM = { ...DM_ROW, id: 'new-row', platformItemId: 'new1' };

interface Internals {
  upsertInboxItem: jest.Mock;
  assertWorkspaceAccess(): Promise<void>;
  resolveChannel(): Promise<unknown>;
  loadMyIdentity(): Promise<unknown>;
  loadMyDmIdentity(): Promise<unknown>;
  loadSelfAuthor(): Promise<unknown>;
  findOurPostId(): Promise<unknown>;
  emitCounts(): void;
  itemToNode(): unknown;
  dmItemToDto(): unknown;
  upsertComment: jest.Mock;
  upsertDm: jest.Mock;
}

function build(opts: { markDoneOnReply?: boolean } = {}) {
  const adapter = {
    replyToComment: jest.fn(() => Promise.resolve(CREATED)),
    commentOnPost: jest.fn(() => Promise.resolve(CREATED)),
    deleteComment: jest.fn(() => Promise.resolve(undefined)),
    hideComment: jest.fn(() => Promise.resolve(undefined)),
    deleteDm: jest.fn(() => Promise.resolve(undefined)),
    sendDm: jest.fn(() => Promise.resolve(CREATED)),
    sendTemplateDm: jest.fn(() => Promise.resolve(CREATED)),
    getReplyWindowState: jest.fn(() => Promise.resolve({ canReply: true })),
  };
  const dispatcher = {
    get: jest.fn(() => adapter),
    getDm: jest.fn(() => adapter),
    supportsDm: jest.fn(() => true),
  };
  const sync = {
    syncThread: jest.fn((...args: unknown[]) => {
      log.push({ kind: 'sync' });
      return Promise.resolve({ conversationId: 'cv1', argc: args.length });
    }),
  };
  const resync = { enqueue: jest.fn(() => Promise.resolve(undefined)) };
  const settings = {
    get: jest.fn(() =>
      Promise.resolve({
        ...DEFAULT_INBOX_SETTINGS,
        markDoneOnReply: opts.markDoneOnReply ?? true,
      }),
    ),
  };
  const redis = new FakeSendLockRedis();
  const service = new InboxService(
    { emit: jest.fn() } as never,
    dispatcher as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { countsChanged: jest.fn() } as never,
    sync as never,
    resync as never,
    settings as never,
    { newInbound: jest.fn() } as never,
    new SendLockService(redis),
  );
  const i = service as unknown as Internals;
  i.assertWorkspaceAccess = () => Promise.resolve(undefined);
  i.resolveChannel = () => Promise.resolve({ platformAccountId: 'acct' });
  i.loadMyIdentity = () => Promise.resolve({ handle: 'me', displayName: 'Me' });
  i.loadMyDmIdentity = () =>
    Promise.resolve({ platformId: 'acct', handle: 'me' });
  i.loadSelfAuthor = () => Promise.resolve({});
  i.findOurPostId = () => Promise.resolve(null);
  i.emitCounts = () => undefined;
  i.itemToNode = () => ({});
  i.dmItemToDto = () => ({});
  i.upsertComment = jest.fn(() => Promise.resolve(NEW_ROW));
  i.upsertDm = jest.fn(() => Promise.resolve(NEW_DM));
  i.upsertInboxItem = jest.fn(() => Promise.resolve(NEW_ROW));
  return { service, sync, resync, settings, adapter, redis };
}
type Ctx = ReturnType<typeof build>;

const outbound = (markDone: boolean): SyncIntent => ({
  kind: 'outbound',
  userId: USER,
  markDone,
  at: AT,
});
const refresh: SyncIntent = { kind: 'refresh' };
const legacy: SyncIntent = { kind: 'legacy_status', userId: USER };

interface Row {
  name: string;
  item?: Record<string, unknown>;
  platform?: string;
  run: (c: Ctx) => Promise<unknown>;
  key: string;
  intent: SyncIntent;
}

const ROWS: Row[] = [
  {
    name: 'reply (settings markDoneOnReply: true)',
    item: { ...ROW, fromMe: false },
    run: (c) => c.service.reply(WS, USER, 'row-1', 'hi'),
    key: `${CH}:p1`,
    intent: outbound(true),
  },
  {
    name: 'reply with opts.markDone false',
    item: { ...ROW, fromMe: false },
    run: (c) => c.service.reply(WS, USER, 'row-1', 'hi', { markDone: false }),
    key: `${CH}:p1`,
    intent: outbound(false),
  },
  {
    name: 'sendDm',
    item: DM_ROW,
    run: (c) => c.service.sendDm(WS, USER, `${CH}:conv`, 'hi'),
    key: `${CH}:conv`,
    intent: outbound(true),
  },
  {
    name: 'commentOnPost',
    run: (c) => c.service.commentOnPost(WS, USER, `${CH}:p1`, 'hi'),
    key: `${CH}:p1`,
    intent: outbound(false),
  },
  {
    name: 'sendDmTemplate',
    platform: 'whatsapp',
    item: DM_ROW,
    run: (c) => c.service.sendDmTemplate(WS, USER, `${CH}:conv`, 'tpl', 'en'),
    key: `${CH}:conv`,
    // No per-send markDone: the sender's setting (default true here) decides.
    intent: outbound(true),
  },
  {
    name: 'markThreadRead',
    run: (c) => c.service.markThreadRead(WS, USER, `${CH}:p1`),
    key: `${CH}:p1`,
    intent: refresh,
  },
  {
    name: 'markDmConversationRead',
    run: (c) => c.service.markDmConversationRead(WS, USER, `${CH}:conv`),
    key: `${CH}:conv`,
    intent: refresh,
  },
  {
    name: "updateThreadStatus('done')",
    run: (c) => c.service.updateThreadStatus(WS, USER, `${CH}:p1`, 'done'),
    key: `${CH}:p1`,
    intent: legacy,
  },
  {
    name: 'updateStatus',
    run: (c) => c.service.updateStatus(WS, USER, 'row-1', 'done'),
    key: `${CH}:p1`,
    intent: legacy,
  },
  {
    name: 'archiveCommentThread',
    run: (c) => c.service.archiveCommentThread(WS, USER, `${CH}:p1`),
    key: `${CH}:p1`,
    intent: refresh,
  },
  {
    name: 'archiveDmConversation',
    run: (c) => c.service.archiveDmConversation(WS, USER, `${CH}:conv`),
    key: `${CH}:conv`,
    intent: refresh,
  },
  {
    name: 'deleteComment',
    run: (c) => c.service.deleteComment(WS, USER, 'row-1'),
    key: `${CH}:p1`,
    intent: refresh,
  },
  {
    name: 'deleteDm',
    item: DM_ROW,
    run: (c) => c.service.deleteDm(WS, USER, 'row-1'),
    key: `${CH}:conv`,
    intent: refresh,
  },
  {
    name: 'hideComment',
    run: (c) => c.service.hideComment(WS, USER, 'row-1', true),
    key: `${CH}:p1`,
    intent: refresh,
  },
];

beforeEach(() => {
  log.length = 0;
  selectLog.length = 0;
  script.user = null;
  script.onSelect = () => script.selected;
  script.onRepliedUpdate = null;
  script.item = ROW;
  script.channel = {
    id: CH,
    workspaceId: WS,
    platform: 'instagram',
    platformAccountId: 'acct',
    username: 'me',
    accountName: 'Me',
  };
  script.updated = [
    {
      id: 'row-1',
      workspaceId: WS,
      channelId: CH,
      status: 'done',
      threadKey: `${CH}:p1`,
    },
  ];
  script.selected = [{ at: AT }];
});

describe('InboxService user actions end in syncThread (R1)', () => {
  it.each(ROWS)('$name syncs once with its intent', async (r) => {
    script.item = r.item ?? ROW;
    if (r.platform) {
      script.channel = { ...script.channel, platform: r.platform };
    }
    const c = build();
    await r.run(c);
    expect(c.sync.syncThread).toHaveBeenCalledTimes(1);
    expect(c.sync.syncThread).toHaveBeenCalledWith(WS, r.key, r.intent);
  });

  it('reply: settings markDoneOnReply false is the default', async () => {
    script.item = { ...ROW, fromMe: false };
    const c = build({ markDoneOnReply: false });
    await c.service.reply(WS, USER, 'row-1', 'hi');
    expect(c.sync.syncThread).toHaveBeenCalledWith(
      WS,
      `${CH}:p1`,
      outbound(false),
    );
  });

  it('reply: an explicit opts.markDone skips the settings read', async () => {
    script.item = { ...ROW, fromMe: false };
    const c = build();
    await c.service.reply(WS, USER, 'row-1', 'hi', { markDone: true });
    expect(c.settings.get).not.toHaveBeenCalled();
  });

  it.each([
    ['reply', ROW, (c: Ctx) => c.service.reply(WS, USER, 'row-1', 'hi')],
    [
      'sendDm',
      DM_ROW,
      (c: Ctx) => c.service.sendDm(WS, USER, `${CH}:conv`, 'hi'),
    ],
  ] as const)('%s stamps the author before it syncs', async (_n, item, run) => {
    script.item = { ...item, fromMe: false };
    const c = build();
    await run(c);
    const stampAt = log.findIndex(
      (l) => l.kind === 'update' && l.setKeys.join() === 'authoredByUserId',
    );
    const syncAt = log.findIndex((l) => l.kind === 'sync');
    expect(stampAt).toBeGreaterThanOrEqual(0);
    expect(syncAt).toBeGreaterThan(stampAt);
    const stamp = log[stampAt] as UpdateLog;
    expect(stamp.where).toContain('"authored_by_user_id" is null');
    expect(stamp.params).toContain('new-row');
  });

  it('sendDm acknowledges EVERY unreplied inbound row, not only unread', async () => {
    script.item = DM_ROW;
    const c = build();
    await c.service.sendDm(WS, USER, `${CH}:conv`, 'hi');
    const ack = log.find(
      (l): l is UpdateLog =>
        l.kind === 'update' &&
        l.setKeys.includes('repliedAt') &&
        !l.setKeys.includes('status'),
    );
    expect(ack).toBeDefined();
    expect(ack?.where).toContain('"replied_at" is null');
    expect(ack?.where).not.toContain('"status"');
  });

  it('a failed sync never fails the action; it queues a retry with its intent', async () => {
    script.item = { ...ROW, fromMe: false };
    const c = build();
    c.sync.syncThread.mockRejectedValueOnce(new Error('db down'));
    await expect(
      c.service.reply(WS, USER, 'row-1', 'hi'),
    ).resolves.toBeDefined();
    expect(c.resync.enqueue).toHaveBeenCalledWith(
      WS,
      `${CH}:p1`,
      outbound(true),
    );
  });

  it('a failed settings read falls back to the default instead of failing the reply', async () => {
    script.item = { ...ROW, fromMe: false };
    const c = build();
    c.settings.get.mockRejectedValueOnce(new Error('settings down'));
    await expect(
      c.service.reply(WS, USER, 'row-1', 'hi'),
    ).resolves.toBeDefined();
    expect(c.sync.syncThread).toHaveBeenCalledWith(
      WS,
      `${CH}:p1`,
      outbound(true),
    );
  });

  it('exports SendOptions with the Task 18 fields', () => {
    const o: SendOptions = { markDone: true, typingStartedAt: AT, force: true };
    expect(o.force).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 18: the send lock, the REPLIED_FIRST collision check, mention replies,
// the failure shape.
// ---------------------------------------------------------------------------

const TYPING = new Date('2026-10-26T09:59:00.000Z');
const MATE_AT = new Date('2026-10-26T09:59:05.000Z');
const MATE = { id: 'mate', name: 'Mia', avatarUrl: null };
const MATE_ROW = {
  id: 'mate-row',
  text: 'on it',
  platformCreatedAt: MATE_AT,
  authoredByUserId: 'mate',
};

/** Window query projects `at`; the collision query projects `text`. */
function scriptSelects(collision: Array<Record<string, unknown>>) {
  script.onSelect = (keys) =>
    keys.includes('text') ? collision : [{ at: AT }];
}

const collisionQuery = () => selectLog.find((q) => q.keys.includes('text'));

async function failureOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected the send to fail');
}

describe('REPLIED_FIRST collision check', () => {
  beforeEach(() => {
    script.user = MATE;
  });

  it('dm: a teammate sent after typingStartedAt -> 409 REPLIED_FIRST with by/text/at, nothing sent', async () => {
    script.item = DM_ROW;
    scriptSelects([MATE_ROW]);
    const c = build();
    const err = await failureOf(
      c.service.sendDm(WS, USER, `${CH}:conv`, 'hi', undefined, {
        typingStartedAt: TYPING,
      }),
    );
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getStatus()).toBe(409);
    expect((err as ConflictException).getResponse()).toEqual({
      code: 'REPLIED_FIRST',
      reply: { by: MATE, text: 'on it', at: MATE_AT.toISOString() },
    });
    expect(c.adapter.sendDm).not.toHaveBeenCalled();
    expect((c.service as unknown as Internals).upsertDm).not.toHaveBeenCalled();
    expect(c.sync.syncThread).not.toHaveBeenCalled();
  });

  it('dm: the collision query is scoped to this thread, from_me, after typingStartedAt, not the sender', async () => {
    script.item = DM_ROW;
    scriptSelects([]);
    const c = build();
    await c.service.sendDm(WS, USER, `${CH}:conv`, 'hi', undefined, {
      typingStartedAt: TYPING,
    });
    const q = collisionQuery();
    expect(q?.where).toContain('"from_me"');
    expect(q?.where).toContain('"platform_created_at" >');
    expect(q?.where).toContain('"conversation_id"');
    expect(q?.where).toContain('"authored_by_user_id"');
    expect(q?.params).toEqual(
      expect.arrayContaining([TYPING.toISOString(), USER]),
    );
  });

  it('dm: a reply made on the platform (no author) reports by: null', async () => {
    script.item = DM_ROW;
    scriptSelects([{ ...MATE_ROW, authoredByUserId: null }]);
    const c = build();
    const err = (await failureOf(
      c.service.sendDm(WS, USER, `${CH}:conv`, 'hi', undefined, {
        typingStartedAt: TYPING,
      }),
    )) as ConflictException;
    expect(err.getResponse()).toMatchObject({
      reply: { by: null, text: 'on it' },
    });
  });

  it('dm: force sends anyway, and never even runs the collision query', async () => {
    script.item = DM_ROW;
    scriptSelects([MATE_ROW]);
    const c = build();
    await c.service.sendDm(WS, USER, `${CH}:conv`, 'hi', undefined, {
      typingStartedAt: TYPING,
      force: true,
    });
    expect(c.adapter.sendDm).toHaveBeenCalledTimes(1);
    expect(collisionQuery()).toBeUndefined();
  });

  it('dm: with no typingStartedAt there is no collision check', async () => {
    script.item = DM_ROW;
    scriptSelects([MATE_ROW]);
    const c = build();
    await c.service.sendDm(WS, USER, `${CH}:conv`, 'hi');
    expect(c.adapter.sendDm).toHaveBeenCalledTimes(1);
    expect(collisionQuery()).toBeUndefined();
  });

  it('comment: answering comment A while a teammate answered comment B sends (per-comment check)', async () => {
    script.item = { ...ROW, fromMe: false, repliedAt: null };
    // Nothing is a reply UNDER comment A, so the (scoped) query is empty.
    scriptSelects([]);
    const c = build();
    await c.service.reply(WS, USER, 'row-1', 'hi', {
      typingStartedAt: TYPING,
    });
    expect(c.adapter.replyToComment).toHaveBeenCalledTimes(1);
    const q = collisionQuery();
    expect(q?.where).toContain('"platform_parent_id"');
    expect(q?.params).toContain('c1');
    expect(q?.where).not.toContain('"thread_key"');
  });

  it('comment: a teammate replied under the SAME comment after typingStartedAt -> 409', async () => {
    script.item = { ...ROW, fromMe: false };
    scriptSelects([MATE_ROW]);
    const c = build();
    const err = await failureOf(
      c.service.reply(WS, USER, 'row-1', 'hi', { typingStartedAt: TYPING }),
    );
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toEqual({
      code: 'REPLIED_FIRST',
      reply: { by: MATE, text: 'on it', at: MATE_AT.toISOString() },
    });
    expect(c.adapter.replyToComment).not.toHaveBeenCalled();
  });

  it('comment: the target answered after typingStartedAt (no row to show) -> 409 with the answering teammate', async () => {
    script.item = {
      ...ROW,
      fromMe: false,
      repliedAt: MATE_AT,
      repliedByUserId: 'mate',
    };
    scriptSelects([]);
    const c = build();
    const err = (await failureOf(
      c.service.reply(WS, USER, 'row-1', 'hi', { typingStartedAt: TYPING }),
    )) as ConflictException;
    expect(err.getResponse()).toEqual({
      code: 'REPLIED_FIRST',
      reply: { by: MATE, text: '', at: MATE_AT.toISOString() },
    });
    expect(c.adapter.replyToComment).not.toHaveBeenCalled();
  });

  it('comment: force skips it', async () => {
    script.item = { ...ROW, fromMe: false };
    scriptSelects([MATE_ROW]);
    const c = build();
    await c.service.reply(WS, USER, 'row-1', 'hi', {
      typingStartedAt: TYPING,
      force: true,
    });
    expect(c.adapter.replyToComment).toHaveBeenCalledTimes(1);
  });

  it('two concurrent sends with the same typingStartedAt: the lock makes the second see the first and get 409', async () => {
    script.item = DM_ROW;
    script.user = { id: 'A', name: 'Ann', avatarUrl: null };
    const sent: Array<Record<string, unknown>> = [];
    scriptSelects(sent);
    // A's platform call takes a moment, so B reaches the check while A is in flight.
    const c = build();
    c.adapter.sendDm.mockImplementation(
      () => new Promise((r) => setTimeout(() => r(CREATED), 30)),
    );
    (c.service as unknown as Internals).upsertDm.mockImplementation(() => {
      sent.push({
        id: 'a-row',
        text: 'hello',
        platformCreatedAt: MATE_AT,
        authoredByUserId: 'A',
      });
      return Promise.resolve(NEW_DM);
    });

    const opts = { typingStartedAt: TYPING };
    const a = c.service.sendDm(WS, 'A', `${CH}:conv`, 'hello', undefined, opts);
    const b = c.service.sendDm(WS, 'B', `${CH}:conv`, 'hello', undefined, opts);
    const [ra, rb] = await Promise.allSettled([a, b]);
    expect(ra.status).toBe('fulfilled');
    expect(rb.status).toBe('rejected');
    expect(
      ((rb as PromiseRejectedResult).reason as ConflictException).getResponse(),
    ).toMatchObject({ code: 'REPLIED_FIRST', reply: { text: 'hello' } });
    expect(c.adapter.sendDm).toHaveBeenCalledTimes(1);
  });
});

describe('mention replies', () => {
  const MENTION = {
    ...ROW,
    type: 'mention',
    platform: 'threads',
    platformItemId: 'm1',
    platformPostId: null,
    fromMe: false,
    threadKey: `${CH}:mention:m1`,
    metadata: {},
  };

  it('replies on the platform with the mention id as parent and post, and persists a mention row in the same conversation', async () => {
    script.item = MENTION;
    const c = build();
    await c.service.reply(WS, USER, 'row-1', 'hi');
    expect(c.adapter.replyToComment).toHaveBeenCalledWith(
      expect.anything(),
      'm1',
      'm1',
      'hi',
    );
    const i = c.service as unknown as Internals;
    expect(i.upsertComment).not.toHaveBeenCalled();
    expect(i.upsertInboxItem).toHaveBeenCalledTimes(1);
    const [input, type] = i.upsertInboxItem.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(type).toBe('mention');
    expect(input).toMatchObject({
      isMention: false,
      fromMe: true,
      platformParentId: 'm1',
      metadata: { mentionRoot: 'm1' },
      authoredByUserId: USER,
    });
    expect(input.platformPostId).toBeUndefined();
    expect(c.sync.syncThread).toHaveBeenCalledWith(
      WS,
      `${CH}:mention:m1`,
      outbound(true),
    );
  });

  it('a reply to our reply keeps the original mentionRoot', async () => {
    script.item = {
      ...MENTION,
      platformItemId: 'r1',
      metadata: { mentionRoot: 'm1' },
    };
    const c = build();
    await c.service.reply(WS, USER, 'row-1', 'again');
    const i = c.service as unknown as Internals;
    const [input] = i.upsertInboxItem.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(input).toMatchObject({
      platformParentId: 'r1',
      metadata: { mentionRoot: 'm1' },
    });
  });

  it('a comment with no post that is not a mention is still refused', async () => {
    script.item = { ...ROW, platformPostId: null };
    const c = build();
    await expect(c.service.reply(WS, USER, 'row-1', 'hi')).rejects.toThrow(
      /no associated post/,
    );
  });
});

describe('failure shape', () => {
  const sendError = (e: unknown) => {
    expect(e).toBeInstanceOf(InboxSendError);
    const ex = e as InboxSendError;
    return { status: ex.getStatus(), body: ex.getResponse() };
  };

  it('reply: an adapter 500 becomes 502 PLATFORM_ERROR and nothing is written', async () => {
    script.item = { ...ROW, fromMe: false };
    const c = build();
    c.adapter.replyToComment.mockRejectedValueOnce(
      new Error('Request failed with status code 500'),
    );
    const err = await failureOf(c.service.reply(WS, USER, 'row-1', 'hi'));
    expect(sendError(err)).toEqual({
      status: 502,
      body: {
        code: 'PLATFORM_ERROR',
        message: 'Request failed with status code 500',
        retryable: true,
      },
    });
    const i = c.service as unknown as Internals;
    expect(i.upsertComment).not.toHaveBeenCalled();
    expect(c.sync.syncThread).not.toHaveBeenCalled();
  });

  it('sendDm: an adapter 500 becomes 502 PLATFORM_ERROR and no row is upserted', async () => {
    script.item = DM_ROW;
    const c = build();
    c.adapter.sendDm.mockRejectedValueOnce(
      new Error('Request failed with status code 500'),
    );
    const err = await failureOf(c.service.sendDm(WS, USER, `${CH}:conv`, 'hi'));
    expect(sendError(err).body).toMatchObject({ code: 'PLATFORM_ERROR' });
    expect((c.service as unknown as Internals).upsertDm).not.toHaveBeenCalled();
  });

  it('commentOnPost: a platform failure is shaped too', async () => {
    const c = build();
    c.adapter.commentOnPost.mockRejectedValueOnce(
      new Error('(#4) Application request limit reached, 429'),
    );
    const err = await failureOf(
      c.service.commentOnPost(WS, USER, `${CH}:p1`, 'hi'),
    );
    expect(sendError(err)).toMatchObject({
      status: 429,
      body: { code: 'RATE_LIMITED', retryable: true },
    });
  });

  it('sendDmTemplate: a platform failure is shaped too', async () => {
    script.item = DM_ROW;
    script.channel = { ...script.channel, platform: 'whatsapp' };
    const c = build();
    c.adapter.sendTemplateDm.mockRejectedValueOnce(
      new Error('Error validating access token: Session has expired'),
    );
    const err = await failureOf(
      c.service.sendDmTemplate(WS, USER, `${CH}:conv`, 'tpl', 'en'),
    );
    expect(sendError(err).body).toMatchObject({ code: 'CHANNEL_DISCONNECTED' });
  });

  it('a channel that is not connected is 409 CHANNEL_DISCONNECTED, before any platform call', async () => {
    script.item = { ...ROW, fromMe: false };
    const c = build();
    (c.service as unknown as Internals).resolveChannel = () =>
      Promise.reject(new ChannelNotConnectedError());
    const err = await failureOf(c.service.reply(WS, USER, 'row-1', 'hi'));
    expect(sendError(err)).toMatchObject({
      status: 409,
      body: { code: 'CHANNEL_DISCONNECTED', retryable: false },
    });
    expect(c.adapter.replyToComment).not.toHaveBeenCalled();
  });

  it('a dm send after the window closed is 403 REPLY_WINDOW_CLOSED and nothing is sent', async () => {
    script.item = DM_ROW;
    const c = build();
    c.adapter.getReplyWindowState.mockResolvedValueOnce({
      canReply: false,
      reason: 'The 24 hour window has closed',
    } as never);
    const err = await failureOf(c.service.sendDm(WS, USER, `${CH}:conv`, 'hi'));
    expect(sendError(err)).toEqual({
      status: 403,
      body: {
        code: 'REPLY_WINDOW_CLOSED',
        message: 'The 24 hour window has closed',
        retryable: false,
      },
    });
    expect(c.adapter.sendDm).not.toHaveBeenCalled();
  });

  it('a workspace-access Forbidden is not turned into a closed window (D19)', async () => {
    script.item = DM_ROW;
    const c = build();
    (c.service as unknown as Internals).assertWorkspaceAccess = () =>
      Promise.reject(new ForbiddenException('Not a member'));
    const err = await failureOf(c.service.sendDm(WS, USER, `${CH}:conv`, 'hi'));
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err).not.toBeInstanceOf(InboxSendError);
  });
});

describe('sendDmTemplate markDone', () => {
  it('opts.markDone true syncs with markDone true and skips the settings read', async () => {
    script.item = DM_ROW;
    script.channel = { ...script.channel, platform: 'whatsapp' };
    const c = build({ markDoneOnReply: false });
    await c.service.sendDmTemplate(WS, USER, `${CH}:conv`, 'tpl', 'en', {
      markDone: true,
    });
    expect(c.sync.syncThread).toHaveBeenCalledWith(
      WS,
      `${CH}:conv`,
      outbound(true),
    );
    expect(c.settings.get).not.toHaveBeenCalled();
  });

  it('without markDone it follows the sender setting', async () => {
    script.item = DM_ROW;
    script.channel = { ...script.channel, platform: 'whatsapp' };
    const c = build({ markDoneOnReply: false });
    await c.service.sendDmTemplate(WS, USER, `${CH}:conv`, 'tpl', 'en');
    expect(c.sync.syncThread).toHaveBeenCalledWith(
      WS,
      `${CH}:conv`,
      outbound(false),
    );
  });
});

describe('loadItemForResponse', () => {
  it('returns the item inside the workspace', async () => {
    script.item = NEW_ROW;
    const c = build();
    await expect(
      c.service.loadItemForResponse(WS, 'new-row'),
    ).resolves.toMatchObject({ id: 'new-row' });
  });

  it('404s when there is none', async () => {
    script.item = undefined as never;
    const c = build();
    await expect(c.service.loadItemForResponse(WS, 'nope')).rejects.toThrow(
      /not found/i,
    );
  });
});

describe('lock scope and the replied_at write (review fixes)', () => {
  it('YouTube nested reply: the target is marked replied INSIDE the lock, so the next sender gets 409', async () => {
    // The first reply's row is stored under the top-level comment, so the
    // per-comment child query finds nothing; only the target's replied_at can
    // tell the second sender. Its UPDATE is slow (600 ms): written after the
    // lock was released, the second sender (retrying every 250 ms) would slip in.
    script.item = {
      ...ROW,
      platform: 'youtube',
      fromMe: false,
      platformParentId: 'top',
      repliedAt: null,
    };
    scriptSelects([]);
    script.user = { id: 'A', name: 'Ann', avatarUrl: null };
    script.onRepliedUpdate = async (values) => {
      await new Promise((r) => setTimeout(r, 600));
      script.item = {
        ...script.item,
        repliedAt: values.repliedAt,
        repliedByUserId: values.repliedByUserId,
      };
    };
    const c = build();
    const opts = { typingStartedAt: TYPING };
    const a = c.service.reply(WS, 'A', 'row-1', 'one', opts);
    const b = c.service.reply(WS, 'B', 'row-1', 'two', opts);
    const [ra, rb] = await Promise.allSettled([a, b]);
    expect(ra.status).toBe('fulfilled');
    expect(rb.status).toBe('rejected');
    expect(
      ((rb as PromiseRejectedResult).reason as ConflictException).getResponse(),
    ).toMatchObject({ code: 'REPLIED_FIRST', reply: { by: { id: 'A' } } });
    expect(c.adapter.replyToComment).toHaveBeenCalledTimes(1);
  });

  it('dm lock key is the decoded channel:conversation, so 07:conv and 7:conv share one lock', async () => {
    script.item = DM_ROW;
    const c = build();
    const set = jest.spyOn(c.redis, 'set');
    await c.service.sendDm(WS, USER, `0${CH}:conv`, 'hi');
    expect(set.mock.calls[0][0]).toBe(`inbox-send:${CH}:conv`);
  });

  it('comment lock key is the answered comment, not the post', async () => {
    script.item = { ...ROW, fromMe: false };
    const c = build();
    const set = jest.spyOn(c.redis, 'set');
    await c.service.reply(WS, USER, 'row-1', 'hi');
    expect(set.mock.calls[0][0]).toBe(`inbox-send:${CH}:c1`);
  });
});
