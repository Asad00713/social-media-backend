import type { PoolClient } from 'pg';
import { describeDb, withRollbackDb } from '../planner/testing/rollback-db';
import { PlatformStatusRepository } from './platform-status.repository';
import { PlatformStatusService } from './platform-status.service';

/** The tables, then the index on posts (each applied twice). */
const MIGRATIONS = [
  '0083_platform_status.sql',
  '0086_posts_updated_at_index.sql',
];

/** A platform no real row uses, so the local database's own data never
 *  leaks into the counts. */
const P = 'zz_status_test';

const tag = () => Math.random().toString(36).slice(2, 8);
const ago = (now: Date, minutes: number) =>
  new Date(now.getTime() - minutes * 60_000);

async function seedUser(client: PoolClient): Promise<string> {
  const u = await client.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, 'Status') RETURNING id`,
    [`status-${tag()}@example.test`],
  );
  return u.rows[0].id;
}

async function seedWorkspace(
  client: PoolClient,
  owner: string,
): Promise<string> {
  const w = await client.query<{ id: string }>(
    `INSERT INTO workspace (name, slug, owner_id) VALUES ('S', $1, $2) RETURNING id`,
    [`s-${tag()}`, owner],
  );
  return w.rows[0].id;
}

async function seedChannel(
  client: PoolClient,
  workspaceId: string,
  owner: string,
): Promise<number> {
  const c = await client.query<{ id: string }>(
    `INSERT INTO social_media_channels
       (workspace_id, platform, account_type, platform_account_id, account_name, access_token, connected_by_user_id)
     VALUES ($1, $2, 'profile', $3, $3, 'x', $4) RETURNING id`,
    [workspaceId, P, `acct-${tag()}`, owner],
  );
  return Number(c.rows[0].id);
}

async function seedPost(
  client: PoolClient,
  v: {
    workspaceId: string;
    owner: string;
    status: string;
    scheduledAt?: Date | null;
    updatedAt?: Date;
    targets?: unknown[];
  },
): Promise<string> {
  const p = await client.query<{ id: string }>(
    `INSERT INTO posts (workspace_id, created_by_id, status, scheduled_at, targets, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id`,
    [
      v.workspaceId,
      v.owner,
      v.status,
      v.scheduledAt ?? null,
      JSON.stringify(v.targets ?? []),
      v.updatedAt ?? new Date(),
    ],
  );
  return p.rows[0].id;
}

async function history(
  client: PoolClient,
  postId: string,
  channelId: number,
  action: string,
  at: Date,
  errorMessage?: string,
): Promise<void> {
  // As PostService.recordHistory writes it: the platform column stays NULL,
  // the platform goes in details.
  await client.query(
    `INSERT INTO post_history (post_id, action, channel_id, details, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [
      postId,
      action,
      channelId,
      JSON.stringify(
        errorMessage ? { platform: P, errorMessage } : { platform: P },
      ),
      at,
    ],
  );
}

describeDb('platform status on Postgres (0083, 0086)', () => {
  it('reads every signal source, and only the window', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      const now = new Date();
      const owner = await seedUser(client);
      const w1 = await seedWorkspace(client, owner);
      const w2 = await seedWorkspace(client, owner);
      const c1 = await seedChannel(client, w1, owner);
      const c2 = await seedChannel(client, w2, owner);

      // Went out 5 minutes late on its first attempt: an outcome and a lag.
      const a = await seedPost(client, {
        workspaceId: w1,
        owner,
        status: 'published',
        scheduledAt: ago(now, 20),
      });
      await history(client, a, c1, 'published', ago(now, 15));

      // Failed, then published by a retry: two outcomes, no lag sample.
      const b = await seedPost(client, {
        workspaceId: w2,
        owner,
        status: 'published',
        scheduledAt: ago(now, 30),
      });
      await history(client, b, c2, 'failed', ago(now, 25), 'status code 503');
      await history(client, b, c2, 'published', ago(now, 10));

      // Our per-channel limiter, as the history writes it.
      const c = await seedPost(client, {
        workspaceId: w1,
        owner,
        status: 'failed',
      });
      await history(
        client,
        c,
        c1,
        'rate_limited',
        ago(now, 5),
        'Per-channel rate limit exceeded',
      );

      // Outside the 30-minute window.
      const d = await seedPost(client, {
        workspaceId: w1,
        owner,
        status: 'published',
      });
      await history(client, d, c1, 'published', ago(now, 120));

      // The composer's "publish now": only the attempt in the window counts;
      // a reminder and a garbled timestamp are skipped.
      await seedPost(client, {
        workspaceId: w2,
        owner,
        status: 'partially_published',
        targets: [
          {
            platform: P,
            publishStatus: 'failed',
            errorCode: 'transient',
            errorMessage: 'ETIMEDOUT',
            attemptedAt: ago(now, 3).toISOString(),
          },
          {
            platform: P,
            publishStatus: 'published',
            attemptedAt: ago(now, 120).toISOString(),
          },
          {
            platform: P,
            publishStatus: 'failed',
            attemptedAt: 'yesterday-ish',
          },
          {
            platform: P,
            publishStatus: 'published',
            reminderSentAt: now.toISOString(),
            attemptedAt: ago(now, 1).toISOString(),
          },
          {
            platform: 'instagram',
            publishStatus: 'published',
            attemptedAt: ago(now, 1).toISOString(),
          },
        ],
      });

      // Not picked up 50 minutes past its time: our queue, never a sample.
      await seedPost(client, {
        workspaceId: w2,
        owner,
        status: 'scheduled',
        scheduledAt: ago(now, 50),
        targets: [{ channelId: String(c2), platform: P, status: 'draft' }],
      });

      // Publishing for 40 minutes past its time; the held target is skipped.
      await seedPost(client, {
        workspaceId: w1,
        owner,
        status: 'publishing',
        scheduledAt: ago(now, 40),
        targets: [
          { channelId: String(c1), platform: P, status: 'draft' },
          {
            channelId: String(c1),
            platform: P,
            status: 'scheduled',
            heldAt: now.toISOString(),
          },
        ],
      });

      // Syncs: one in the window, one five hours ago.
      await client.query(
        `INSERT INTO channel_sync_state (channel_id, last_profile_sync_at, last_profile_sync_status, last_profile_sync_error, next_profile_sync_at)
         VALUES ($1, $2, 'rate_limited', 'slow down', $3), ($4, $5, 'failed', 'x', $3)`,
        [c1, ago(now, 10), now, c2, ago(now, 300)],
      );

      const repo = new PlatformStatusRepository(db);
      const signals = (await repo.loadSignals([P], now)).get(P)!;

      expect(
        signals.publishes
          .map(
            (o) =>
              `${o.workspaceId === w1 ? 'w1' : 'w2'}:${o.result}:${o.errorCode ?? ''}:${o.errorMessage ?? ''}`,
          )
          .sort(),
      ).toEqual(
        [
          'w1:published::',
          'w2:failed::status code 503',
          'w2:published::',
          'w1:failed::Per-channel rate limit exceeded',
          'w2:failed:transient:ETIMEDOUT',
        ].sort(),
      );
      const lags = signals.lags
        .map(
          (l) =>
            `${l.workspaceId === w1 ? 'w1' : 'w2'}:${Math.round(l.lagMs / 60_000)}`,
        )
        .sort();
      expect(lags).toEqual(['w1:40', 'w1:5']);
      expect(signals.syncs).toEqual([
        { workspaceId: w1, result: 'rate_limited', errorMessage: 'slow down' },
      ]);
    }));

  it('stores the plan, keeps history, and lets an incident override it', () =>
    withRollbackDb(MIGRATIONS, async (db, client) => {
      // Start from empty status tables (the local database may hold rows
      // from a dev run); the harness rolls this back.
      await client.query(
        'DELETE FROM platform_status_changes; DELETE FROM platform_status; DELETE FROM platform_incidents',
      );
      const owner = await seedUser(client);
      const repo = new PlatformStatusRepository(db);
      const broadcast = jest.fn();
      const service = new PlatformStatusService(repo, { broadcast } as never);
      const now = new Date('2026-11-15T10:00:00Z');

      const inc = await client.query<{ id: string }>(
        `INSERT INTO platform_incidents (platform, severity, title, created_by)
         VALUES ('tiktok', 'outage', 'TikTok is down', $1) RETURNING id`,
        [owner],
      );
      const changes = await service.applyIncidents(now);
      expect(changes.map((c) => `${c.platform}:${c.from}->${c.to}`)).toEqual([
        'tiktok:operational->outage',
      ]);
      expect(broadcast).toHaveBeenCalledTimes(1);

      const stored = await repo.loadStored(db);
      expect(stored.get('tiktok')).toMatchObject({
        status: 'outage',
        measuredStatus: 'operational',
        reason: 'incident',
        incidentId: inc.rows[0].id,
      });

      // Again: no change, no second history row, no second broadcast.
      await service.applyIncidents(now);
      expect(broadcast).toHaveBeenCalledTimes(1);
      const page = await service.getStatusPage(
        new Date('2026-11-15T10:05:00Z'),
      );
      expect(page.changes).toHaveLength(1);
      expect(page.incidents.map((i) => i.title)).toEqual(['TikTok is down']);
      expect(
        page.platforms.find((p) => p.platform === 'tiktok')?.incident,
      ).toEqual({
        id: inc.rows[0].id,
        title: 'TikTok is down',
      });

      // Resolved: back to the measurement.
      await client.query(
        `UPDATE platform_incidents SET resolved_at = now() WHERE id = $1`,
        [inc.rows[0].id],
      );
      const back = await service.applyIncidents(
        new Date('2026-11-15T10:10:00Z'),
      );
      expect(back.map((c) => `${c.platform}:${c.from}->${c.to}`)).toEqual([
        'tiktok:outage->operational',
      ]);
    }));

  it.each([
    [
      'an unknown severity',
      `INSERT INTO platform_incidents (severity, title) VALUES ('meh', 't')`,
      'platform_incidents_severity_chk',
    ],
    [
      'a blank title',
      `INSERT INTO platform_incidents (severity, title) VALUES ('outage', '  ')`,
      'platform_incidents_title_chk',
    ],
    [
      'a resolve before the start',
      `INSERT INTO platform_incidents (severity, title, started_at, resolved_at) VALUES ('outage', 't', now(), now() - interval '1 hour')`,
      'platform_incidents_resolved_chk',
    ],
    [
      'an unknown state',
      `INSERT INTO platform_status (platform, status, measured_status) VALUES ('x', 'meh', 'operational')`,
      'platform_status_status_chk',
    ],
    [
      'a change to the same state',
      `INSERT INTO platform_status_changes (platform, from_status, to_status) VALUES ('x', 'delayed', 'delayed')`,
      'platform_status_changes_differ_chk',
    ],
  ])('refuses %s', (_label, statement, constraint) =>
    withRollbackDb(MIGRATIONS, async (_db, client) => {
      await client.query('SAVEPOINT chk');
      await expect(client.query(statement)).rejects.toMatchObject({
        constraint,
      });
      await client.query('ROLLBACK TO SAVEPOINT chk');
    }),
  );
});
