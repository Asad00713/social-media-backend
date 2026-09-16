/**
 * Guard against pointing a migration command at a database you did not mean.
 *
 * The repo's `.env` carries four DATABASE_URL lines — three commented out, one
 * of them a Railway PRODUCTION proxy URL. Uncommenting or reordering that file
 * silently retargets `db:migrate:sql` and `db:baseline`, both of which execute
 * DDL and write irreversible tracking state, from a developer laptop.
 *
 * Inside the container this never fires: Railway's runtime host is
 * `*.railway.internal`, which is treated as the deploy target and allowed.
 * What it catches is a laptop pointed at a public production proxy.
 */

/** Accepts both `--upto <file>` and `--upto=<file>`. */
export function parseUpto(argv: string[]): string | null {
  const joined = argv.find((a) => a.startsWith('--upto='));
  if (joined) return joined.slice('--upto='.length) || null;
  const i = argv.indexOf('--upto');
  if (i === -1 || !argv[i + 1]) return null;
  return argv[i + 1];
}

export interface TargetDecision {
  allowed: boolean;
  host: string;
  reason?: string;
}

/** Hosts that are unambiguously not production. */
function isLocal(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]'
  );
}

/** The private network a Railway container uses to reach its own database. */
function isDeployInternal(host: string): boolean {
  return host.endsWith('.railway.internal');
}

export function hostOf(connectionString: string): string {
  try {
    return new URL(connectionString).hostname;
  } catch {
    return '';
  }
}

/**
 * Decide whether a command may run against this connection string.
 *
 * `confirmed` is the explicit opt-in (`--i-know-this-is-production`). Without
 * it, anything that is neither localhost nor the deploy-internal network is
 * refused — the dangerous target should take a deliberate act to reach.
 */
export function decideTarget(
  connectionString: string,
  confirmed: boolean,
): TargetDecision {
  const host = hostOf(connectionString);

  if (!host) {
    return {
      allowed: false,
      host: '(unparseable)',
      reason: 'DATABASE_URL could not be parsed as a URL.',
    };
  }
  if (isLocal(host) || isDeployInternal(host)) return { allowed: true, host };
  if (confirmed) return { allowed: true, host };

  return {
    allowed: false,
    host,
    reason:
      `refusing to run against "${host}", which is neither localhost nor the ` +
      'deploy-internal network. This command executes DDL and writes ' +
      'irreversible tracking state. If you really mean to target it, re-run ' +
      'with --i-know-this-is-production.',
  };
}
