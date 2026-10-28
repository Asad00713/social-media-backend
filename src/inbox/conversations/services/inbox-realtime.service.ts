import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbType } from '../../../drizzle/db';
import { DRIZZLE } from '../../../drizzle/drizzle.module';
import { AnalyticsEventEmitter } from '../../../realtime/analytics-event-emitter.service';
import { computeLegacyCounts } from '../../legacy-counts';
import type { TimelineEntry } from '../dto/contract';
import { ConversationPresenter } from './conversation-presenter.service';

export const CONVERSATION_DEBOUNCE_MS = 300;
export const COUNTS_DEBOUNCE_MS = 500;
export const COUNTS_MAX_WAIT_MS = 2000;

interface PendingConversation {
  workspaceId: string;
  timer: NodeJS.Timeout;
}
/**
 * Flushes of one key currently awaiting the database. `token` is the newest
 * generation allowed to emit; a removal or a newer flush replaces it, so an
 * older flush that resolves late finds a different token and drops its result.
 * The entry is deleted when the last running flush ends.
 */
interface InFlight {
  token: number;
  running: number;
}
interface PendingCounts {
  firstAt: number;
  timer: NodeJS.Timeout;
}

/**
 * Debounced Inbox realtime events. Timers use setTimeout so jest fake timers
 * drive them; a flush never throws.
 */
@Injectable()
export class InboxRealtimeService implements OnModuleDestroy {
  private readonly logger = new Logger(InboxRealtimeService.name);
  private readonly conversations = new Map<string, PendingConversation>();
  private readonly counts = new Map<string, PendingCounts>();
  private readonly conversationFlights = new Map<string, InFlight>();
  private readonly countsFlights = new Map<string, InFlight>();
  private generation = 0;

  constructor(
    private readonly emitter: AnalyticsEventEmitter,
    private readonly presenter: ConversationPresenter,
    @Inject(DRIZZLE) private readonly db: DbType,
  ) {}

  onModuleDestroy(): void {
    for (const p of this.conversations.values()) clearTimeout(p.timer);
    for (const p of this.counts.values()) clearTimeout(p.timer);
    this.conversations.clear();
    this.counts.clear();
    this.conversationFlights.clear();
    this.countsFlights.clear();
  }

  /** Starts a flush for `key`; returns its token and a finisher. */
  private beginFlight(
    flights: Map<string, InFlight>,
    key: string,
  ): { isCurrent: () => boolean; end: () => void } {
    const token = ++this.generation;
    const flight = flights.get(key) ?? { token, running: 0 };
    flight.token = token;
    flight.running += 1;
    flights.set(key, flight);
    return {
      isCurrent: () => flight.token === token,
      end: () => {
        flight.running -= 1;
        if (flight.running === 0 && flights.get(key) === flight) {
          flights.delete(key);
        }
      },
    };
  }

  /** Trailing debounce, 300 ms per conversation id. */
  conversationChanged(workspaceId: string, conversationId: string): void {
    const pending = this.conversations.get(conversationId);
    if (pending) clearTimeout(pending.timer);
    const timer = setTimeout(() => {
      this.conversations.delete(conversationId);
      void this.flushConversation(workspaceId, conversationId);
    }, CONVERSATION_DEBOUNCE_MS);
    this.conversations.set(conversationId, { workspaceId, timer });
  }

  conversationRemoved(workspaceId: string, conversationId: string): void {
    const pending = this.conversations.get(conversationId);
    if (pending) {
      clearTimeout(pending.timer);
      this.conversations.delete(conversationId);
    }
    // Invalidate any flush already past its timer.
    const flight = this.conversationFlights.get(conversationId);
    if (flight) flight.token = ++this.generation;
    this.emitter.emit(workspaceId, 'inbox.conversation.removed', {
      workspaceId,
      id: conversationId,
    });
  }

  /** Trailing debounce 500 ms, max wait 2000 ms, per workspace. */
  countsChanged(workspaceId: string): void {
    const now = Date.now();
    const pending = this.counts.get(workspaceId);
    const firstAt = pending?.firstAt ?? now;
    if (pending) clearTimeout(pending.timer);
    const delay = Math.max(
      0,
      Math.min(COUNTS_DEBOUNCE_MS, firstAt + COUNTS_MAX_WAIT_MS - now),
    );
    const timer = setTimeout(() => {
      this.counts.delete(workspaceId);
      void this.flushCounts(workspaceId);
    }, delay);
    this.counts.set(workspaceId, { firstAt, timer });
  }

  timelineAppended(
    workspaceId: string,
    conversationId: string,
    entry: TimelineEntry | null,
    commentId: string | null,
  ): void {
    this.emitter.emit(workspaceId, 'inbox.timeline.appended', {
      workspaceId,
      conversationId,
      entry,
      commentId,
    });
  }

  private async flushConversation(
    workspaceId: string,
    conversationId: string,
  ): Promise<void> {
    const flight = this.beginFlight(this.conversationFlights, conversationId);
    try {
      // loadRows returns archived rows too (D7), so check archived_at here.
      const res = await this.db.execute<{ archived_at: Date | null }>(sql`
        SELECT archived_at FROM inbox_conversations
         WHERE id = ${conversationId}::uuid
           AND workspace_id = ${workspaceId}::uuid
      `);
      const row = res.rows[0];
      if (!flight.isCurrent()) return;
      if (!row || row.archived_at !== null) {
        this.emitter.emit(workspaceId, 'inbox.conversation.removed', {
          workspaceId,
          id: conversationId,
        });
        return;
      }
      const [presented] = await this.presenter.loadRows(workspaceId, [
        conversationId,
      ]);
      if (!flight.isCurrent()) return;
      if (!presented) {
        this.emitter.emit(workspaceId, 'inbox.conversation.removed', {
          workspaceId,
          id: conversationId,
        });
        return;
      }
      this.emitter.emit(workspaceId, 'inbox.conversation.upserted', {
        workspaceId,
        row: presented,
      });
    } catch (err) {
      this.logger.error(
        `Failed to emit conversation ${conversationId} for ws=${workspaceId}: ${(err as Error).message}`,
      );
    } finally {
      flight.end();
    }
  }

  private async flushCounts(workspaceId: string): Promise<void> {
    const flight = this.beginFlight(this.countsFlights, workspaceId);
    try {
      const [counts, legacy] = await Promise.all([
        this.presenter.counts(workspaceId),
        computeLegacyCounts(this.db, workspaceId),
      ]);
      if (!flight.isCurrent()) return;
      this.emitter.emit(workspaceId, 'inbox.conversation.counts.changed', {
        workspaceId,
        counts,
      });
      this.emitter.emit(workspaceId, 'inbox.counts.changed', {
        workspaceId,
        perChannel: legacy.perChannel,
        smartFolders: legacy.smartFolders,
      });
    } catch (err) {
      this.logger.error(
        `Failed to emit inbox counts for ws=${workspaceId}: ${(err as Error).message}`,
      );
    } finally {
      flight.end();
    }
  }
}
