import { Injectable, Logger } from '@nestjs/common';
import { AnalyticsEventEmitter } from '../realtime/analytics-event-emitter.service';
import type {
  PlatformIncidentRow,
  PlatformState,
} from '../drizzle/schema/platform-status.schema';
import { measurePlatform, type Measurement } from './lib/classify';
import {
  planStatus,
  type ActiveIncident,
  type StatusChange,
} from './lib/effective-status';
import {
  STATE_MESSAGES,
  STATUS_PLATFORMS,
  type StatusPlatform,
} from './lib/status-platforms';
import { PlatformStatusRepository } from './platform-status.repository';
import type {
  PlatformStatusDto,
  StatusChangeDto,
  StatusIncidentDto,
  StatusPageDto,
} from './dto/status-page.dto';

/** How far back the status page's history reaches. */
export const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60_000;

export function toIncidentDto(row: PlatformIncidentRow): StatusIncidentDto {
  return {
    id: row.id,
    platform: row.platform,
    severity: row.severity,
    title: row.title,
    body: row.body ?? null,
    startedAt: row.startedAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Platform health: measures every publishing platform, folds in the
 * incidents a super admin posted, stores the result, and tells every
 * connected client when a platform's shown state changes.
 */
@Injectable()
export class PlatformStatusService {
  private readonly logger = new Logger(PlatformStatusService.name);

  constructor(
    private readonly repo: PlatformStatusRepository,
    private readonly emitter: AnalyticsEventEmitter,
  ) {}

  /** The two-minute job: measure, then reconcile with the incidents. */
  async recompute(now = new Date()): Promise<StatusChange[]> {
    const signals = await this.repo.loadSignals(STATUS_PLATFORMS, now);
    return this.reconcile(now, (stored) => {
      const measured = new Map<string, Measurement>();
      for (const platform of STATUS_PLATFORMS) {
        measured.set(
          platform,
          measurePlatform(
            signals.get(platform) ?? { publishes: [], lags: [], syncs: [] },
            stored.get(platform)?.measuredStatus ?? 'operational',
          ),
        );
      }
      return measured;
    });
  }

  /**
   * Re-applies the incidents to the stored measurements, without measuring:
   * an incident posted, edited or resolved shows at once instead of at the
   * next run.
   */
  async applyIncidents(now = new Date()): Promise<StatusChange[]> {
    return this.reconcile(now, () => new Map());
  }

  private async reconcile(
    now: Date,
    measure: (
      stored: Awaited<ReturnType<PlatformStatusRepository['loadStored']>>,
    ) => Map<string, Measurement>,
  ): Promise<StatusChange[]> {
    const { changes, incidents } = await this.repo.withStatusLock(
      async (tx) => {
        const stored = await this.repo.loadStored(tx);
        const active = await this.repo.activeIncidents(tx);
        const plan = planStatus({
          platforms: STATUS_PLATFORMS,
          stored,
          measured: measure(stored),
          incidents: active,
          now,
        });
        await this.repo.save(tx, plan.rows, plan.changes, now);
        return { changes: plan.changes, incidents: active };
      },
    );
    // After the commit: a client told of a change must find it on the page.
    for (const change of changes) this.announce(change, incidents);
    if (changes.length) {
      this.logger.log(
        `Platform status changed: ${changes
          .map((c) => `${c.platform} ${c.from}->${c.to} (${c.reason ?? '-'})`)
          .join(', ')}`,
      );
    }
    return changes;
  }

  /**
   * To every connected client, not per workspace: the payload carries no
   * workspace data (it is the public status page's), each client already
   * knows which platforms its workspace uses, and one broadcast beats
   * looking up and emitting to every workspace with an Instagram channel.
   */
  private announce(change: StatusChange, incidents: ActiveIncident[]): void {
    const incident = change.incidentId
      ? incidents.find((i) => i.id === change.incidentId)
      : undefined;
    this.emitter.broadcast('platform.status.changed', {
      platform: change.platform,
      status: change.to,
      previousStatus: change.from,
      since: change.at.toISOString(),
      reason: change.reason,
      message: STATE_MESSAGES[change.to],
      incident: incident ? { id: incident.id, title: incident.title } : null,
    });
  }

  /** The status page: every platform, open incidents, the last 7 days. */
  async getStatusPage(now = new Date()): Promise<StatusPageDto> {
    const since = new Date(now.getTime() - HISTORY_WINDOW_MS);
    const [rows, open, resolved, changes] = await Promise.all([
      this.repo.statusRows(),
      this.repo.openIncidents(),
      this.repo.resolvedSince(since),
      this.repo.changesSince(since),
    ]);
    const byPlatform = new Map(rows.map((r) => [r.platform, r]));
    const incidentTitle = new Map(open.map((i) => [i.id, i.title]));

    const platforms: PlatformStatusDto[] = STATUS_PLATFORMS.map(
      (platform: StatusPlatform) => {
        const row = byPlatform.get(platform);
        const status: PlatformState = row?.status ?? 'operational';
        const incidentId = row?.incidentId ?? null;
        return {
          platform,
          status,
          since: row ? row.since.toISOString() : null,
          reason: row?.reason ?? null,
          message: STATE_MESSAGES[status],
          incident:
            incidentId && incidentTitle.has(incidentId)
              ? { id: incidentId, title: incidentTitle.get(incidentId)! }
              : null,
        };
      },
    );
    const measuredAt = rows
      .map((r) => r.measuredAt?.getTime() ?? 0)
      .reduce((a, b) => Math.max(a, b), 0);

    const history: StatusChangeDto[] = changes
      .filter((c) =>
        (STATUS_PLATFORMS as readonly string[]).includes(c.platform),
      )
      .map((c) => ({
        id: c.id,
        platform: c.platform,
        from: c.fromStatus,
        to: c.toStatus,
        reason: c.reason ?? null,
        incidentId: c.incidentId ?? null,
        at: c.createdAt.toISOString(),
      }));

    return {
      platforms,
      incidents: open.map(toIncidentDto),
      resolvedIncidents: resolved.map(toIncidentDto),
      changes: history,
      checkedAt: measuredAt ? new Date(measuredAt).toISOString() : null,
    };
  }
}
