import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '../../drizzle/db';
import { chatMessages } from '../../drizzle/schema/chatbot.schema';

/**
 * How long a turn may claim to be running before it is considered abandoned.
 *
 * A turn is bounded by `maxTurns: 8` and a model that answers in seconds; the
 * slowest realistic turn — several tool calls and a long reply — is minutes.
 * Fifteen is far past that, so a row still `running` by then belongs to a
 * process that is no longer alive. Erring long matters more than erring short:
 * closing a turn that is still streaming would mark a live answer as failed.
 */
const STRANDED_AFTER_MS = 15 * 60 * 1000;

/** Rows per pass. A backlog drains over successive runs rather than in one. */
const BATCH = 200;

/**
 * Closes Maestro turns abandoned mid-flight.
 *
 * `streamMessage` opens its assistant row as `running` before the model runs
 * and closes it — `complete`, `stopped` or `failed` — on the way out. Every
 * ordinary ending goes through that `finally`, including a user pressing Stop
 * and the model erroring out.
 *
 * What does NOT reach it is the process dying: a Railway deploy, an OOM kill,
 * a crash. `finally` does not run for a `SIGKILL`, and the abort signal is
 * never raised either, so the row simply stays `running` — the state it was in
 * while the answer was still being written. Nothing else in the system would
 * ever revisit it, and on reload the user sees their question with a reply that
 * is permanently half-written, or empty.
 *
 * This is the repair, and it is the reason the turn record is worth having:
 * before it, an abandoned turn was indistinguishable from one that was never
 * asked, because there was no row at all until a reply existed.
 *
 * ## It never re-runs a turn
 *
 * The sweeper only writes bookkeeping. It does not call the model, re-charge
 * anyone, or try to finish the answer — a turn the user has long since
 * navigated away from must not suddenly produce a reply, and the tokens for a
 * second attempt were never spent. A turn that wrote something keeps what it
 * wrote, marked `failed`; one that wrote nothing is deleted, because an empty
 * assistant bubble reads as Maestro having answered with silence.
 *
 * Runs every 10 minutes and once at boot — boot matters most, since a deploy
 * is the likeliest cause of a stranded turn and the new process starts
 * immediately after. On healthy data it is a no-op.
 *
 * ⚠ The `@Cron` name is load-bearing: `cron-lock.bootstrap.ts` and
 * `cron-role.gate.ts` wrap the `SchedulerRegistry` and key on it, so a NAMED
 * cron is single-run and role-gated for free while an unnamed one would run on
 * every replica at once.
 */
@Injectable()
export class StrandedTurnSweeperService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StrandedTurnSweeperService.name);

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    // Not awaited: boot must neither wait on nor fail with a repair pass.
    void this.sweep().catch((error: unknown) => {
      this.logger.error(
        `Boot stranded-turn sweep failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  @Cron('*/10 * * * *', { timeZone: 'UTC', name: 'maestroStrandedTurnSweep' })
  async everyTenMinutes(): Promise<void> {
    await this.sweep();
  }

  /** Closes abandoned turns. Returns how many were repaired. */
  async sweep(): Promise<number> {
    const cutoff = new Date(Date.now() - STRANDED_AFTER_MS);

    // `->>` yields text, so the comparison is against the string 'running'.
    // Indexed by `chat_messages_created_at_idx` on the date half; the status
    // test runs over what that narrows to, which is near-empty in healthy data.
    const stranded = await db
      .select({
        id: chatMessages.id,
        content: chatMessages.content,
        metadata: chatMessages.metadata,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.role, 'assistant'),
          lt(chatMessages.createdAt, cutoff),
          sql`${chatMessages.metadata}->'maestroTurn'->>'status' = 'running'`,
        ),
      )
      .limit(BATCH);

    if (stranded.length === 0) return 0;

    let repaired = 0;
    for (const row of stranded) {
      try {
        if (row.content && row.content.trim()) {
          const prior = (row.metadata ?? {}) as Record<string, unknown>;
          const turn = (prior.maestroTurn ?? {}) as Record<string, unknown>;
          await db
            .update(chatMessages)
            .set({
              metadata: {
                ...prior,
                maestroTurn: {
                  ...turn,
                  status: 'failed',
                  endedAt: new Date().toISOString(),
                },
              } as never,
            })
            .where(eq(chatMessages.id, row.id));
        } else {
          // Nothing was ever written into it. Deleting leaves the transcript
          // exactly as it was before turn rows existed, where a turn that died
          // early saved nothing at all.
          await db.delete(chatMessages).where(eq(chatMessages.id, row.id));
        }
        repaired++;
      } catch (error: unknown) {
        // One bad row must not stop the pass; the next run retries it.
        this.logger.error(
          `Failed to close stranded turn ${row.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.logger.warn(
      `Closed ${repaired} stranded Maestro turn(s) older than ${
        STRANDED_AFTER_MS / 60000
      }m`,
    );
    return repaired;
  }
}
