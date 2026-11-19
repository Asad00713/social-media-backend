/**
 * What this process is for.
 *
 * ## Why this exists
 *
 * One process serves HTTP, runs all 28 crons and processes all 24 BullMQ
 * queues. A heavy publish therefore blocks the event loop that is also
 * answering the dashboard, and the two cannot be scaled apart.
 *
 * Running a second copy of the service does NOT fix that: both copies would
 * still do both jobs, so an API request can still land on the process that is
 * busy uploading a video. Capacity doubles; isolation stays zero. The split
 * has to happen inside the process, which is what this decides.
 *
 * ## The roles
 *
 * | ROLE     | HTTP          | Queues | Crons |
 * |----------|---------------|--------|-------|
 * | `all`    | yes           | yes    | yes   |
 * | `web`    | yes           | no     | no    |
 * | `worker` | health only   | yes    | yes   |
 *
 * ## Why the default is `all`
 *
 * An unset or misspelled variable must mean "behave exactly as this service
 * behaves today". The failure mode of the opposite default is a worker that
 * silently stops publishing because somebody forgot an environment variable —
 * the same reason the cron lock is not an env flag (`docs/cron-single-run.md`).
 *
 * A value we do not recognise is therefore `all` plus a loud warning, never a
 * crash and never a guess.
 */
export const PROCESS_ROLES = ['all', 'web', 'worker'] as const;

export type ProcessRole = (typeof PROCESS_ROLES)[number];

export const DEFAULT_PROCESS_ROLE: ProcessRole = 'all';

/** Which env var names this. */
export const PROCESS_ROLE_ENV = 'ROLE';

export function parseProcessRole(raw: string | undefined): {
  role: ProcessRole;
  unrecognised: string | null;
} {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return { role: DEFAULT_PROCESS_ROLE, unrecognised: null };
  if ((PROCESS_ROLES as readonly string[]).includes(value)) {
    return { role: value as ProcessRole, unrecognised: null };
  }
  // Fall back to today's behaviour rather than refusing to boot: a typo in a
  // dashboard field must not take the platform down.
  return { role: DEFAULT_PROCESS_ROLE, unrecognised: raw ?? '' };
}

/** Read the role from the environment. */
export function processRole(env: NodeJS.ProcessEnv = process.env): ProcessRole {
  return parseProcessRole(env[PROCESS_ROLE_ENV]).role;
}

/** Does this process answer ordinary HTTP routes? */
export function servesHttp(role: ProcessRole): boolean {
  return role !== 'worker';
}

/** Does this process run BullMQ workers? */
export function runsQueues(role: ProcessRole): boolean {
  return role !== 'web';
}

/**
 * Does this process run scheduled jobs?
 *
 * Crons follow the queues: almost every cron's job is to enqueue work, so a
 * process that cannot drain the queue has no business filling it. The cron
 * single-run lock still applies — a rolling deploy briefly runs two workers.
 */
export function runsCrons(role: ProcessRole): boolean {
  return runsQueues(role);
}
