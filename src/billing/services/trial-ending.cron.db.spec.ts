import type { ConfigService } from '@nestjs/config';
import type { PoolClient } from 'pg';
import { AppLinks } from '../../email/links/app-links';
import { RecipientsService } from '../../notifications/recipients.service';
import { describeDb, withRollbackDb } from '../../planner/testing/rollback-db';
import { BillingEmailService } from './billing-email.service';
import { TrialEndingCron } from './trial-ending.cron';

const NOW = new Date('2026-11-14T09:00:00Z');
const HOUR_MS = 60 * 60 * 1000;
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR_MS);

const rand = () => Math.random().toString(36).slice(2, 10);

/** The two plans a subscription row points at, when the database lacks them. */
async function ensurePlans(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO plans (code, name, base_price_cents, channels_per_workspace,
                        members_per_workspace, max_workspaces)
     VALUES ('FREE', 'Free', 0, 3, 1, 1), ('PRO', 'Pro', 2900, 8, 5, 3)
     ON CONFLICT (code) DO NOTHING`,
  );
}

interface SeedSub {
  status: string;
  trialEnd: Date;
  cancelAtPeriodEnd?: boolean;
  provider: 'lemonsqueezy' | 'stripe';
  itemType?: string;
}

async function seedSubscription(
  client: PoolClient,
  seed: SeedSub,
): Promise<{ id: number; userId: string }> {
  const u = await client.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, 'Payer') RETURNING id`,
    [`payer-${rand()}@example.test`],
  );
  const userId = u.rows[0].id;
  const s = await client.query<{ id: number }>(
    `INSERT INTO subscriptions
       (user_id, plan_code, status, trial_end, cancel_at_period_end)
     VALUES ($1, 'PRO', $2, $3, $4) RETURNING id`,
    // As an ISO string, the way drizzle writes the column: a raw Date would
    // go through node-pg's local-time formatting and shift by the host offset.
    [
      userId,
      seed.status,
      seed.trialEnd.toISOString(),
      seed.cancelAtPeriodEnd ?? false,
    ],
  );
  await client.query(
    `INSERT INTO provider_subscriptions
       (subscription_id, provider, item_type, provider_subscription_id)
     VALUES ($1, $2, $3, $4)`,
    [s.rows[0].id, seed.provider, seed.itemType ?? 'BASE_PLAN', `p-${rand()}`],
  );
  return { id: s.rows[0].id, userId };
}

describeDb('TrialEndingCron (database)', () => {
  it('picks the Lemon Squeezy trials ending within 3 days, missed runs included, and sends once across two runs', async () => {
    await withRollbackDb([], async (db, client) => {
      await ensurePlans(client);
      const inWindow = await seedSubscription(client, {
        status: 'trialing',
        trialEnd: at(60),
        provider: 'lemonsqueezy',
      });
      // Exactly 3 days is in: the mail never goes out earlier than that.
      const upperEdge = await seedSubscription(client, {
        status: 'trialing',
        trialEnd: at(72),
        provider: 'lemonsqueezy',
      });
      // A run that was missed: these are inside 2 days now and still go out.
      const missed = await seedSubscription(client, {
        status: 'trialing',
        trialEnd: at(30),
        provider: 'lemonsqueezy',
      });
      const lastDay = await seedSubscription(client, {
        status: 'trialing',
        trialEnd: at(1),
        provider: 'lemonsqueezy',
      });
      // Already over, set to cancel: nobody to warn.
      await seedSubscription(client, {
        status: 'trialing',
        trialEnd: at(-1),
        provider: 'lemonsqueezy',
      });
      await seedSubscription(client, {
        status: 'trialing',
        trialEnd: at(60),
        provider: 'lemonsqueezy',
        cancelAtPeriodEnd: true,
      });
      await seedSubscription(client, {
        status: 'trialing',
        trialEnd: at(73),
        provider: 'lemonsqueezy',
      });
      await seedSubscription(client, {
        status: 'trialing',
        trialEnd: at(60),
        provider: 'stripe',
      });
      await seedSubscription(client, {
        status: 'active',
        trialEnd: at(60),
        provider: 'lemonsqueezy',
      });
      await seedSubscription(client, {
        status: 'trialing',
        trialEnd: at(60),
        provider: 'lemonsqueezy',
        itemType: 'EXTRA_CHANNEL',
      });

      const notify = { notify: jest.fn().mockResolvedValue(undefined) };
      const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
      const claimed = new Set<string>();
      const once = {
        claim: jest.fn((key: string) => {
          const first = !claimed.has(key);
          claimed.add(key);
          return Promise.resolve(first);
        }),
      };
      const billingEmail = new BillingEmailService(
        db,
        notify as never,
        new RecipientsService(db),
        once as never,
        new AppLinks({ get: () => undefined } as unknown as ConfigService),
        {} as never,
        outbox as never,
      );
      const cron = new TrialEndingCron(db, billingEmail);

      const first = await cron.sendDue(NOW);
      const second = await cron.sendDue(NOW);

      // Both runs see the same four trials; the claim lets only the first send.
      expect(first).toBe(4);
      expect(second).toBe(4);
      const sentTo = (
        outbox.enqueue.mock.calls as Array<[{ to: { userId: string } }]>
      )
        .map(([mail]) => mail.to.userId)
        .sort();
      expect(sentTo).toEqual(
        [inWindow, upperEdge, missed, lastDay].map((s) => s.userId).sort(),
      );
    });
  });
});
