// InboxService imports `db` as a module-level singleton, so jest.mock the
// module with a scripted chainable fake. Every `update` is logged in call
// order (set keys + rendered WHERE), and so is every `syncThread` call, which
// lets a row assert "the author stamp lands BEFORE the sync".
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

interface UpdateLog {
  kind: 'update';
  setKeys: string[];
  where: string;
  params: unknown[];
}
interface SyncLog {
  kind: 'sync';
}
const log: Array<UpdateLog | SyncLog> = [];
const script = {
  item: {} as Record<string, unknown>,
  channel: {} as Record<string, unknown>,
  updated: [] as Array<Record<string, unknown>>,
  selected: [] as Array<Record<string, unknown>>,
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
    select: jest.fn(() => chain(() => script.selected)),
    update: jest.fn(() => {
      const entry: UpdateLog = {
        kind: 'update',
        setKeys: [],
        where: '',
        params: [],
      };
      log.push(entry);
      return chain(
        () => script.updated,
        (name, args) => {
          if (name === 'set') entry.setKeys = Object.keys(args[0] as object);
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
      whatsappMessageTemplates: {
        findFirst: jest.fn(() => Promise.resolve({ status: 'APPROVED' })),
      },
    },
  },
}));

import { InboxService } from './inbox.service';
import type { SendOptions } from './inbox.service';
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
  return { service, sync, resync, settings, adapter };
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
    intent: outbound(false),
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
