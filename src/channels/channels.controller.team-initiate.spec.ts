/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- the controller is built with Object.create and its private collaborators are set by name */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';

const inserted: Array<Record<string, unknown>> = [];

jest.mock('../drizzle/db', () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return Promise.resolve();
      },
    }),
  },
}));

import { ChannelsController } from './channels.controller';
import { OAuthService } from './services/oauth.service';

/**
 * The signed-in initiate (`POST /channels/workspaces/:ws/oauth/initiate`)
 * stores a TEAM state. A link state is written only by the public link start
 * (ConnectLinkAccessService.start), so whatever a team client puts in
 * `additionalData`, the stored state must never carry `connectLinkId`: only
 * the keys a team connect actually uses survive.
 */
const WS = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';

function build() {
  const oauth = new OAuthService();
  jest
    .spyOn(
      oauth as unknown as { getPlatformCredentials: () => Promise<unknown> },
      'getPlatformCredentials',
    )
    .mockResolvedValue({ clientId: 'cid', clientSecret: 'secret' });
  const initiate = jest.spyOn(oauth, 'initiateOAuth');
  const c: any = Object.create(ChannelsController.prototype);
  c.oauthService = oauth;
  return { c, initiate };
}

describe('ChannelsController.initiateOAuth (team)', () => {
  const ORIGINAL_ENV = { ...process.env };
  let logSpy: jest.SpyInstance;
  beforeAll(() => {
    process.env.APP_URL = 'https://api.schedura.test';
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });
  beforeEach(() => {
    inserted.length = 0;
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('a body carrying connectLinkId produces a team state without it', async () => {
    const { c } = build();
    await c.initiateOAuth(
      WS,
      { userId: USER, email: 'u@test' },
      {
        platform: 'linkedin',
        additionalData: { connectLinkId: LINK, intent: 'connect' },
      },
    );
    expect(inserted).toHaveLength(1);
    const state = inserted[0];
    expect(state.workspaceId).toBe(WS);
    expect(state.userId).toBe(USER);
    const data = state.additionalData as Record<string, unknown>;
    expect(data).not.toHaveProperty('connectLinkId');
    expect(data.intent).toBe('connect');
  });

  it('keeps only the team keys: unknown and server-owned keys are dropped', async () => {
    const { c, initiate } = build();
    await c.initiateOAuth(
      WS,
      { userId: USER, email: 'u@test' },
      {
        platform: 'facebook',
        additionalData: {
          intent: 'ads',
          connectLinkId: LINK,
          _oauthRedirectUri: 'https://evil.test/cb',
          channelId: '21',
          anything: 'else',
        },
      },
    );
    expect(initiate.mock.calls[0][2].additionalData).toEqual({
      intent: 'ads',
    });
    const data = inserted[0].additionalData as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['_oauthRedirectUri', 'intent']);
    // the server still writes its own redirect uri, not the client's
    expect(data._oauthRedirectUri).toBe(
      'https://api.schedura.test/channels/oauth/facebook/callback',
    );
  });

  it('no additionalData stays a plain team state', async () => {
    const { c, initiate } = build();
    await c.initiateOAuth(
      WS,
      { userId: USER, email: 'u@test' },
      { platform: 'linkedin' },
    );
    expect(initiate.mock.calls[0][2].additionalData).toEqual({});
    expect(inserted[0].additionalData).not.toHaveProperty('connectLinkId');
  });
});
