import type {
  IncidentSeverity,
  PlatformState,
  PlatformStatusReason,
} from '../../drizzle/schema/platform-status.schema';

/**
 * GET /status. Mirrored on the frontend in
 * src/features/platform-status/types/platform-status.types.ts.
 */
export interface StatusPageDto {
  /** Every reported platform, in the page's order. */
  platforms: PlatformStatusDto[];
  /** Unresolved incidents, newest first. */
  incidents: StatusIncidentDto[];
  /** Incidents resolved in the last 7 days, newest first. */
  resolvedIncidents: StatusIncidentDto[];
  /** Changes of a platform's state in the last 7 days, newest first. */
  changes: StatusChangeDto[];
  /** When the platforms were last measured; null before the first run. */
  checkedAt: string | null;
}

export interface PlatformStatusDto {
  platform: string;
  status: PlatformState;
  /** When it entered this state; null if it has never been measured. */
  since: string | null;
  reason: PlatformStatusReason | null;
  /** What it means for the customer's posts. */
  message: string;
  /** The incident that set this state, if one did. */
  incident: { id: string; title: string } | null;
}

export interface StatusIncidentDto {
  id: string;
  /** null = every platform. */
  platform: string | null;
  severity: IncidentSeverity;
  title: string;
  body: string | null;
  startedAt: string;
  resolvedAt: string | null;
  updatedAt: string;
}

export interface StatusChangeDto {
  id: string;
  platform: string;
  from: PlatformState;
  to: PlatformState;
  reason: PlatformStatusReason | null;
  incidentId: string | null;
  at: string;
}
