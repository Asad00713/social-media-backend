import { BadRequestException } from '@nestjs/common';
import type { NotificationPreferencesRepository } from './notification-preferences.repository';
import { NotificationPauseService } from './notification-pause.service';

const USER = 'user-1';
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-17T12:00:00.000Z');

function setup(stored: Date | null = null) {
  const repo = {
    pausedUntil: jest.fn().mockResolvedValue(stored),
    setPausedUntil: jest.fn().mockResolvedValue(undefined),
  };
  const service = new NotificationPauseService(
    repo as unknown as NotificationPreferencesRepository,
  );
  return { repo, service };
}

async function rejectionOf(p: Promise<unknown>): Promise<BadRequestException> {
  try {
    await p;
  } catch (e) {
    return e as BadRequestException;
  }
  throw new Error('expected a rejection');
}

describe('NotificationPauseService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  describe('get', () => {
    it('is null when nothing is stored', async () => {
      const { service } = setup(null);
      expect(await service.get(USER)).toEqual({ pausedUntil: null });
    });

    it('returns a future instant as ISO 8601', async () => {
      const until = new Date(NOW.getTime() + 3 * DAY);
      const { service, repo } = setup(until);
      expect(await service.get(USER)).toEqual({
        pausedUntil: until.toISOString(),
      });
      expect(repo.pausedUntil).toHaveBeenCalledWith(USER);
    });

    it('is null when the stored value is in the past (the pause has ended)', async () => {
      const { service } = setup(new Date(NOW.getTime() - 1000));
      expect(await service.get(USER)).toEqual({ pausedUntil: null });
    });

    it('is null when the stored value is exactly now', async () => {
      const { service } = setup(new Date(NOW.getTime()));
      expect(await service.get(USER)).toEqual({ pausedUntil: null });
    });
  });

  describe('set', () => {
    it('stores a valid future instant and answers with it', async () => {
      const until = new Date(NOW.getTime() + 2 * DAY);
      const { service, repo } = setup(until);
      expect(await service.set(USER, until)).toEqual({
        pausedUntil: until.toISOString(),
      });
      expect(repo.setPausedUntil).toHaveBeenCalledWith(USER, until);
    });

    it('allows exactly 30 days', async () => {
      const until = new Date(NOW.getTime() + 30 * DAY);
      const { service, repo } = setup(until);
      await service.set(USER, until);
      expect(repo.setPausedUntil).toHaveBeenCalledWith(USER, until);
    });

    it('rejects more than 30 days with PAUSE_TOO_LONG, writing nothing', async () => {
      const { service, repo } = setup();
      const err = await rejectionOf(
        service.set(USER, new Date(NOW.getTime() + 31 * DAY)),
      );
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
        code: 'PAUSE_TOO_LONG',
      });
      expect(repo.setPausedUntil).not.toHaveBeenCalled();
    });

    it('rejects 30 days plus one millisecond', async () => {
      const { service } = setup();
      const err = await rejectionOf(
        service.set(USER, new Date(NOW.getTime() + 30 * DAY + 1)),
      );
      expect(err.getResponse()).toMatchObject({ code: 'PAUSE_TOO_LONG' });
    });

    it('rejects an instant in the past with PAUSE_IN_PAST, writing nothing', async () => {
      const { service, repo } = setup();
      const err = await rejectionOf(
        service.set(USER, new Date(NOW.getTime() - 60_000)),
      );
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
        code: 'PAUSE_IN_PAST',
      });
      expect(repo.setPausedUntil).not.toHaveBeenCalled();
    });

    it('rejects "now" itself: a pause that has already ended', async () => {
      const { service } = setup();
      const err = await rejectionOf(service.set(USER, new Date(NOW.getTime())));
      expect(err.getResponse()).toMatchObject({ code: 'PAUSE_IN_PAST' });
    });

    it('rejects an Invalid Date with PAUSE_INVALID, writing nothing', async () => {
      const { service, repo } = setup();
      const err = await rejectionOf(service.set(USER, new Date('nope')));
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        statusCode: 400,
        code: 'PAUSE_INVALID',
      });
      expect(repo.setPausedUntil).not.toHaveBeenCalled();
    });

    it('null clears the pause', async () => {
      const { service, repo } = setup(null);
      expect(await service.set(USER, null)).toEqual({ pausedUntil: null });
      expect(repo.setPausedUntil).toHaveBeenCalledWith(USER, null);
    });
  });
});
