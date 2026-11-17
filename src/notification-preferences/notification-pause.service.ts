import { BadRequestException, Injectable } from '@nestjs/common';
import { NotificationPreferencesRepository } from './notification-preferences.repository';

/** The longest a pause may run, counted from the moment of the request. */
export const MAX_PAUSE_DAYS = 30;
const MAX_PAUSE_MS = MAX_PAUSE_DAYS * 24 * 60 * 60 * 1000;

export interface PauseState {
  /** ISO 8601 instant the pause ends, or null when not paused. */
  pausedUntil: string | null;
}

function rejection(
  code: 'PAUSE_TOO_LONG' | 'PAUSE_IN_PAST',
  message: string,
): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code,
    message,
  });
}

/**
 * "Pause notifications": the signed-in person mutes everything except failed
 * posts and security alerts until an instant at most 30 days away. The send
 * path reads the same column (NotificationPreferencesService.shouldSend).
 */
@Injectable()
export class NotificationPauseService {
  constructor(private readonly repo: NotificationPreferencesRepository) {}

  /** A pause whose end has passed reads as no pause. */
  async get(userId: string): Promise<PauseState> {
    const until = await this.repo.pausedUntil(userId);
    return {
      pausedUntil: until && until > new Date() ? until.toISOString() : null,
    };
  }

  /** `until` null clears the pause. */
  async set(userId: string, until: Date | null): Promise<PauseState> {
    if (until !== null) {
      const now = Date.now();
      if (until.getTime() <= now) {
        throw rejection('PAUSE_IN_PAST', 'The pause must end in the future.');
      }
      if (until.getTime() > now + MAX_PAUSE_MS) {
        throw rejection(
          'PAUSE_TOO_LONG',
          `Notifications can be paused for at most ${MAX_PAUSE_DAYS} days.`,
        );
      }
    }
    await this.repo.setPausedUntil(userId, until);
    return { pausedUntil: until ? until.toISOString() : null };
  }
}
