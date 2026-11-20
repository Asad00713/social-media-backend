import type { ConfigService } from '@nestjs/config';
import { MaestroBridgeProcessor } from './maestro-bridge.processor';
import {
  MAESTRO_BRIDGE_COMING_SOON_TEXT,
  MaestroLaunch,
} from '../../maestro-launch';

const PNID = 'pnid-maestro';
const LINK = {
  id: 'link-1',
  userId: 'user-1',
  channel: 'telegram',
  externalId: '42',
  defaultWorkspaceId: 'ws-1',
  metadata: {},
};

function waPayload(
  messages: Array<{ id: string; from: string; text: string }>,
  pnid = PNID,
) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: pnid },
              contacts: messages.map((m) => ({
                wa_id: m.from,
                profile: { name: 'Someone' },
              })),
              messages: messages.map((m) => ({
                id: m.id,
                from: m.from,
                timestamp: '1700000000',
                type: 'text',
                text: { body: m.text },
              })),
            },
          },
        ],
      },
    ],
  };
}

function build(enabled: string | undefined) {
  const env: Record<string, string | undefined> = {
    MAESTRO_ENABLED: enabled,
    MAESTRO_WHATSAPP_PHONE_NUMBER_ID: PNID,
    MAESTRO_WHATSAPP_TOKEN: 'wa-token',
    MAESTRO_TELEGRAM_BOT_TOKEN: 'tg-token',
  };
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;

  const tg = {
    sendMessage: jest.fn().mockResolvedValue(undefined),
    answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
  };
  const telegram = { forToken: jest.fn(() => tg) };
  const whatsapp = { sendText: jest.fn().mockResolvedValue(undefined) };
  const links = {
    findLink: jest.fn().mockResolvedValue(LINK),
    verifyLinkToken: jest.fn().mockReturnValue({
      userId: 'user-1',
      workspaceId: 'ws-1',
    }),
    upsertLink: jest.fn().mockResolvedValue(undefined),
    getThread: jest.fn().mockResolvedValue(null),
    touchThread: jest.fn(),
    setThreadConversation: jest.fn().mockResolvedValue(undefined),
    setPending: jest.fn().mockResolvedValue(undefined),
    resetThread: jest.fn(),
    setDefaultWorkspace: jest.fn(),
  };
  const maestro = {
    createConversation: jest.fn().mockResolvedValue({ id: 'conv-1' }),
    runHeadlessTurn: jest.fn().mockResolvedValue({ text: 'agent answer' }),
  };
  const workspaces = { findAllByUser: jest.fn().mockResolvedValue([]) };
  const events = { emit: jest.fn() };

  const processor = new MaestroBridgeProcessor(
    links as never,
    maestro as never,
    telegram as never,
    whatsapp as never,
    workspaces as never,
    events as never,
    config,
    new MaestroLaunch(config),
  );
  return { processor, tg, whatsapp, links, maestro, workspaces };
}

type BridgeJob = Parameters<MaestroBridgeProcessor['process']>[0];

function job(data: Record<string, unknown>): BridgeJob {
  return { data } as unknown as BridgeJob;
}

const tgMessage = (text: string) =>
  job({
    channel: 'telegram',
    update: {
      update_id: 1,
      message: { chat: { id: 42 }, from: { id: 42 }, text },
    },
  });

describe('MaestroBridgeProcessor while Maestro is OFF', () => {
  describe.each([
    ['unset', undefined],
    ['"false"', 'false'],
  ])('MAESTRO_ENABLED %s', (_label, value) => {
    it.each([
      ['a normal message', 'what is in my inbox?'],
      ['a connect command', '/start sometoken'],
      ['/switch', '/switch'],
      ['/new', '/new'],
    ])(
      'telegram %s: one fixed reply, agent never runs, nothing linked',
      async (_name, text) => {
        const t = build(value);
        await t.processor.process(tgMessage(text));

        expect(t.tg.sendMessage).toHaveBeenCalledTimes(1);
        expect(t.tg.sendMessage).toHaveBeenCalledWith(
          42,
          MAESTRO_BRIDGE_COMING_SOON_TEXT,
        );
        expect(t.maestro.runHeadlessTurn).not.toHaveBeenCalled();
        expect(t.maestro.createConversation).not.toHaveBeenCalled();
        expect(t.links.upsertLink).not.toHaveBeenCalled();
        expect(t.links.setThreadConversation).not.toHaveBeenCalled();
        expect(t.links.setPending).not.toHaveBeenCalled();
      },
    );

    it('telegram button tap: acknowledged, one fixed reply, agent never runs', async () => {
      const t = build(value);
      await t.processor.process(
        job({
          channel: 'telegram',
          update: {
            update_id: 2,
            callback_query: {
              id: 'cb-1',
              from: { id: 42 },
              message: { chat: { id: 42 } },
              data: 'p:0',
            },
          },
        }),
      );
      expect(t.tg.answerCallbackQuery).toHaveBeenCalledWith('cb-1');
      expect(t.tg.sendMessage).toHaveBeenCalledTimes(1);
      expect(t.tg.sendMessage).toHaveBeenCalledWith(
        42,
        MAESTRO_BRIDGE_COMING_SOON_TEXT,
      );
      expect(t.maestro.runHeadlessTurn).not.toHaveBeenCalled();
    });

    it('telegram update with no text: silent', async () => {
      const t = build(value);
      await t.processor.process(
        job({
          channel: 'telegram',
          update: { message: { chat: { id: 42 }, from: { id: 42 } } },
        }),
      );
      expect(t.tg.sendMessage).not.toHaveBeenCalled();
      expect(t.maestro.runHeadlessTurn).not.toHaveBeenCalled();
    });

    it('whatsapp: one fixed reply per message, agent never runs', async () => {
      const t = build(value);
      await t.processor.process(
        job({
          channel: 'whatsapp',
          payload: waPayload([
            { id: 'wamid.1', from: '111', text: 'hello' },
            { id: 'wamid.2', from: '222', text: '/connect tok' },
          ]),
        }),
      );
      expect(t.whatsapp.sendText).toHaveBeenCalledTimes(2);
      expect(t.whatsapp.sendText).toHaveBeenCalledWith(
        'wa-token',
        PNID,
        '111',
        MAESTRO_BRIDGE_COMING_SOON_TEXT,
      );
      expect(t.whatsapp.sendText).toHaveBeenCalledWith(
        'wa-token',
        PNID,
        '222',
        MAESTRO_BRIDGE_COMING_SOON_TEXT,
      );
      expect(t.maestro.runHeadlessTurn).not.toHaveBeenCalled();
      expect(t.maestro.createConversation).not.toHaveBeenCalled();
      expect(t.links.upsertLink).not.toHaveBeenCalled();
    });

    it('whatsapp for another number: silent', async () => {
      const t = build(value);
      await t.processor.process(
        job({
          channel: 'whatsapp',
          payload: waPayload(
            [{ id: 'wamid.3', from: '111', text: 'hello' }],
            'someone-else',
          ),
        }),
      );
      expect(t.whatsapp.sendText).not.toHaveBeenCalled();
    });

    it('a failed send does not throw, so BullMQ cannot retry into a second reply', async () => {
      const t = build(value);
      t.tg.sendMessage.mockRejectedValueOnce(new Error('telegram down'));
      await expect(
        t.processor.process(tgMessage('hello')),
      ).resolves.toBeUndefined();
      expect(t.maestro.runHeadlessTurn).not.toHaveBeenCalled();
    });
  });
});

describe('MaestroBridgeProcessor while Maestro is ON ("true")', () => {
  it('telegram message from a linked user runs the agent and relays its answer', async () => {
    const t = build('true');
    await t.processor.process(tgMessage('what is in my inbox?'));
    expect(t.maestro.runHeadlessTurn).toHaveBeenCalledTimes(1);
    expect(t.tg.sendMessage).toHaveBeenCalledWith(42, 'agent answer');
    expect(t.tg.sendMessage).not.toHaveBeenCalledWith(
      42,
      MAESTRO_BRIDGE_COMING_SOON_TEXT,
    );
  });

  it('a connect command still links the account', async () => {
    const t = build('true');
    await t.processor.process(tgMessage('/start sometoken'));
    expect(t.links.upsertLink).toHaveBeenCalledTimes(1);
    expect(t.maestro.runHeadlessTurn).not.toHaveBeenCalled();
  });

  it('whatsapp message from a linked user runs the agent', async () => {
    const t = build('true');
    await t.processor.process(
      job({
        channel: 'whatsapp',
        payload: waPayload([{ id: 'wamid.9', from: '111', text: 'hello' }]),
      }),
    );
    expect(t.maestro.runHeadlessTurn).toHaveBeenCalledTimes(1);
    expect(t.whatsapp.sendText).toHaveBeenCalledWith(
      'wa-token',
      PNID,
      '111',
      'agent answer',
    );
  });
});
