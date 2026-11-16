import type { PoolClient } from 'pg';
import { describeDb, withRollbackDb } from '../../planner/testing/rollback-db';
import { EmailSuppressionRepository } from './email-suppression.repository';

const MIGRATIONS = ['0069_email_suppressions.sql'];

function run<T>(
  fn: (repo: EmailSuppressionRepository, client: PoolClient) => Promise<T>,
): Promise<T> {
  return withRollbackDb(MIGRATIONS, (db, client) =>
    fn(new EmailSuppressionRepository(db), client),
  );
}

interface Row {
  email: string;
  reason: string;
  resend_email_id: string | null;
}

async function rows(client: PoolClient): Promise<Row[]> {
  const r = await client.query<Row>(
    'SELECT email, reason, resend_email_id FROM email_suppressions ORDER BY email',
  );
  return r.rows;
}

describeDb('EmailSuppressionRepository (database)', () => {
  it('suppress lowercases and upserts; isSuppressed matches case-insensitively', async () => {
    await run(async (repo, client) => {
      await repo.suppress('Bounce@Acme.COM', 'bounced', 'em_1');
      await repo.suppress('bounce@acme.com', 'complained', null);

      expect(await rows(client)).toEqual([
        {
          email: 'bounce@acme.com',
          reason: 'complained',
          resend_email_id: null,
        },
      ]);
      expect(await repo.isSuppressed('BOUNCE@acme.com')).toBe(true);
      expect(await repo.isSuppressed('bounce@acme.com')).toBe(true);
      expect(await repo.isSuppressed('other@acme.com')).toBe(false);
    });
  });

  it('moves updated_at forward on a repeat suppression', async () => {
    await run(async (repo, client) => {
      await repo.suppress('a@acme.com', 'bounced', 'em_1');
      await client.query(
        "UPDATE email_suppressions SET created_at = now() - interval '1 day', updated_at = now() - interval '1 day'",
      );
      await repo.suppress('a@acme.com', 'bounced', 'em_2');
      const r = await client.query<{ fresh: boolean; kept: boolean }>(
        `SELECT updated_at > now() - interval '1 minute' AS fresh,
                created_at < now() - interval '1 hour' AS kept
           FROM email_suppressions`,
      );
      expect(r.rows[0]).toEqual({ fresh: true, kept: true });
      expect((await rows(client))[0].resend_email_id).toBe('em_2');
    });
  });

  it('rejects a mixed-case address or an unknown reason written directly', async () => {
    await run(async (_repo, client) => {
      await client.query('SAVEPOINT s1');
      await expect(
        client.query(
          "INSERT INTO email_suppressions (email, reason) VALUES ('A@acme.com', 'bounced')",
        ),
      ).rejects.toThrow(/email_suppressions_email_lower_chk/);
      await client.query('ROLLBACK TO SAVEPOINT s1');
      await expect(
        client.query(
          "INSERT INTO email_suppressions (email, reason) VALUES ('a@acme.com', 'spam')",
        ),
      ).rejects.toThrow(/email_suppressions_reason_chk/);
      await client.query('ROLLBACK TO SAVEPOINT s1');
    });
  });
});
