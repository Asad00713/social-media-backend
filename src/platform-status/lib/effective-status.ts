import type {
  IncidentSeverity,
  MeasuredReason,
  PlatformSignalsSummary,
  PlatformState,
  PlatformStatusReason,
} from '../../drizzle/schema/platform-status.schema';
import { stateRank, worstState } from './status-platforms';
import type { Measurement } from './classify';

/** An unresolved incident. `platform` null = every platform. */
export interface ActiveIncident {
  id: string;
  platform: string | null;
  severity: IncidentSeverity;
  title: string;
  startedAt: Date;
}

/** A platform_status row as stored. */
export interface StoredStatus {
  platform: string;
  status: PlatformState;
  measuredStatus: PlatformState;
  measuredReason: MeasuredReason | null;
  reason: PlatformStatusReason | null;
  incidentId: string | null;
  signals: Partial<PlatformSignalsSummary>;
  since: Date;
  measuredAt: Date | null;
}

/** A platform_status row to write. */
export interface NextStatus extends StoredStatus {
  changed: boolean;
}

/** One change of the shown state, for the history and the realtime event. */
export interface StatusChange {
  platform: string;
  from: PlatformState;
  to: PlatformState;
  reason: PlatformStatusReason | null;
  incidentId: string | null;
  at: Date;
}

/**
 * The incident that governs `platform`: the worst unresolved one that names
 * it or names every platform; on a tie, the most recent.
 */
export function governingIncident(
  platform: string,
  incidents: ActiveIncident[],
): ActiveIncident | null {
  let best: ActiveIncident | null = null;
  for (const incident of incidents) {
    if (incident.platform !== null && incident.platform !== platform) continue;
    if (
      !best ||
      stateRank(incident.severity) > stateRank(best.severity) ||
      (incident.severity === best.severity &&
        incident.startedAt.getTime() > best.startedAt.getTime())
    ) {
      best = incident;
    }
  }
  return best;
}

/**
 * The next row for every platform. `measured` holds this run's measurements;
 * a platform missing from it (an incident was posted or resolved between two
 * runs) keeps its stored measurement. An active incident overrides the
 * measurement when it is as bad or worse; a milder incident (a "delayed"
 * notice during a measured outage) never hides the worse measured state.
 * A platform with no row yet starts from "operational", so a first
 * measurement of "operational" is not a change.
 */
export function planStatus(input: {
  platforms: readonly string[];
  stored: Map<string, StoredStatus>;
  measured: Map<string, Measurement>;
  incidents: ActiveIncident[];
  now: Date;
}): { rows: NextStatus[]; changes: StatusChange[] } {
  const rows: NextStatus[] = [];
  const changes: StatusChange[] = [];
  for (const platform of input.platforms) {
    const prior = input.stored.get(platform);
    const measurement = input.measured.get(platform);
    const measuredStatus =
      measurement?.status ?? prior?.measuredStatus ?? 'operational';
    const measuredReason =
      measuredStatus === 'operational'
        ? null
        : measurement
          ? measurement.reason
          : (prior?.measuredReason ?? null);

    const incident = governingIncident(platform, input.incidents);
    // The incident governs only when it is at least as bad as the
    // measurement; on a tie it names the cause, which a person wrote.
    const governs =
      incident !== null &&
      stateRank(incident.severity) >= stateRank(measuredStatus);
    const status: PlatformState = incident
      ? worstState(incident.severity, measuredStatus)
      : measuredStatus;
    const reason: PlatformStatusReason | null = governs
      ? 'incident'
      : measuredReason;
    const incidentId = incident && governs ? incident.id : null;

    const before = prior?.status ?? 'operational';
    const changed = before !== status;
    if (changed) {
      changes.push({
        platform,
        from: before,
        to: status,
        reason,
        incidentId,
        at: input.now,
      });
    }
    rows.push({
      platform,
      status,
      measuredStatus,
      measuredReason,
      reason,
      incidentId,
      signals: measurement?.summary ?? prior?.signals ?? {},
      since: changed || !prior ? input.now : prior.since,
      measuredAt: measurement ? input.now : (prior?.measuredAt ?? null),
      changed,
    });
  }
  return { rows, changes };
}
