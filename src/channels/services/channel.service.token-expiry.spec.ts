/* eslint-disable @typescript-eslint/require-await -- service doubles */
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

let channelRow: Record<string, unknown>;

const selectChain = () => ({
  from: () => ({
    where: () => ({ limit: async () => [channelRow] }),
  }),
});
const mockDb = {
  select: jest.fn(selectChain),
  insert: jest.fn(() => ({ values: async () => undefined })),
  execute: jest.fn(async () => undefined),
  update: jest.fn(() => {
    throw new Error('the status write must go through the notifier');
  }),
};

jest.mock('../../drizzle/db', () => ({ db: mockDb }));

import { BadRequestException, Logger } from '@nestjs/common';
import { encrypt } from '../../common/utils/encryption.util';
import { ChannelService } from './channel.service';

const HOUR = 60 * 60 * 1000;

function make(refresh: jest.Mock) {
  const health = { markExpired: jest.fn().mockResolvedValue(undefined) };
  const svc = new ChannelService(
    { refreshAccessToken: refresh } as never,
    {} as never,
    {} as never,
    {} as never,
    health as never,
    {} as never,
  );
  return { svc, health };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 7,
  workspaceId: 'ws',
  platform: 'youtube',
  accountName: 'Cafe',
  isActive: true,
  accessToken: encrypt('access'),
  refreshToken: encrypt('refresh'),
  tokenExpiresAt: new Date(Date.now() - HOUR),
  consecutiveErrors: 2,
  updatedAt: new Date(),
  ...over,
});

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('ChannelService.getAccessToken marks a dead channel expired through the notifier', () => {
  it('when the publish-time refresh fails on an expired token', async () => {
    channelRow = row();
    const { svc, health } = make(
      jest.fn().mockRejectedValue(new Error('invalid_grant')),
    );
    await expect(svc.getAccessToken(7, 'ws')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(health.markExpired).toHaveBeenCalledTimes(1);
    expect(health.markExpired).toHaveBeenCalledWith(7, {
      lastError: 'Token refresh failed',
      lastErrorAt: expect.any(Date) as Date,
      consecutiveErrors: 3,
      updatedAt: expect.any(Date) as Date,
    });
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('not when the token is only about to expire and the refresh fails', async () => {
    channelRow = row({ tokenExpiresAt: new Date(Date.now() + 60 * 1000) });
    const { svc, health } = make(
      jest.fn().mockRejectedValue(new Error('invalid_grant')),
    );
    await expect(svc.getAccessToken(7, 'ws')).resolves.toBe('access');
    expect(health.markExpired).not.toHaveBeenCalled();
  });

  it('when a Bluesky session refresh is refused, and still returns the old token', async () => {
    channelRow = row({
      platform: 'bluesky',
      tokenExpiresAt: null,
      updatedAt: new Date(Date.now() - 3 * HOUR),
    });
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response('ExpiredToken', { status: 400 }) as never,
      );
    const { svc, health } = make(jest.fn());
    await expect(svc.getAccessToken(7, 'ws')).resolves.toBe('access');
    expect(health.markExpired).toHaveBeenCalledWith(7, {
      lastError: 'Bluesky session refresh failed: ExpiredToken',
      lastErrorAt: expect.any(Date) as Date,
      updatedAt: expect.any(Date) as Date,
    });
    fetchMock.mockRestore();
  });

  it('not for a Bluesky server error', async () => {
    channelRow = row({
      platform: 'bluesky',
      tokenExpiresAt: null,
      updatedAt: new Date(Date.now() - 3 * HOUR),
    });
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('oops', { status: 503 }) as never);
    const { svc, health } = make(jest.fn());
    await expect(svc.getAccessToken(7, 'ws')).resolves.toBe('access');
    expect(health.markExpired).not.toHaveBeenCalled();
  });
});
