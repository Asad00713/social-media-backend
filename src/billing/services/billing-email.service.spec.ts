import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { EmailService } from '../../email/email.service';
import { AppLinks } from '../../email/links/app-links';
import { EmailFooterService } from '../../email/queue/email-footer.service';
import { IDEMPOTENCY_KEY_RE } from '../../email/queue/email-job';
import type { EmailJobData } from '../../email/queue/email-job';
import { EmailOutboxService } from '../../email/queue/email-outbox.service';
import { renderEmail } from '../../email/render/render-email';
import { getTemplate } from '../../email/templates/registry';
import type { NotifyService } from '../../notifications/notify.service';
import { NotifyService as RealNotifyService } from '../../notifications/notify.service';
import type {
  Recipient,
  RecipientsService,
} from '../../notifications/recipients.service';
import {
  BillingEmailService,
  billingEmailKey,
  formatMoney,
} from './billing-email.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WS_ID = '22222222-2222-4222-8222-222222222222';
const ADDRESS = 'owner@example.test';

interface Row {
  [column: string]: unknown;
}

/** table name -> rows. Selects ignore `where`: each test seeds what it needs. */
let tables: Record<string, Row[]>;

function tableName(t: unknown): string {
  const sym = Object.getOwnPropertySymbols(t as object).find((s) =>
    String(s).includes('Name'),
  );
  const name = sym ? (t as Record<symbol, unknown>)[sym] : undefined;
  return typeof name === 'string' ? name : 'unknown';
}

function fakeDb(): never {
  return {
    select: () => {
      let target = 'unknown';
      const chain: Record<string, unknown> = {
        from: (t: unknown) => {
          target = tableName(t);
          return chain;
        },
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(tables[target] ?? []).then(resolve),
      };
      return chain;
    },
  } as never;
}

/** A BullMQ stand-in that drops a repeat job id, as the real queue does. */
class FakeQueue {
  readonly jobs = new Map<string, { data: EmailJobData }>();
  /** Set to make the next `add` fail, as a Redis outage would. */
  failNext: Error | null = null;
  /** Set to make the next `add` never answer, as a hung Redis would. */
  hangNext = false;
  add(
    _name: string,
    data: EmailJobData,
    opts: { jobId: string },
  ): void | Promise<never> {
    if (this.hangNext) {
      this.hangNext = false;
      return new Promise<never>(() => undefined);
    }
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    if (!this.jobs.has(opts.jobId)) this.jobs.set(opts.jobId, { data });
  }
}

const PLANS: Row[] = [
  {
    code: 'FREE',
    name: 'Free',
    channelsPerWorkspace: 3,
    membersPerWorkspace: 1,
    aiTokensPerMonth: 0,
  },
  {
    code: 'PRO',
    name: 'Pro',
    channelsPerWorkspace: 8,
    membersPerWorkspace: 5,
    aiTokensPerMonth: 2000,
  },
  {
    code: 'MAX',
    name: 'Max',
    channelsPerWorkspace: -1,
    membersPerWorkspace: 20,
    aiTokensPerMonth: -1,
  },
];

const ENV: Record<string, string | undefined> = {
  FRONTEND_URL: 'https://app.schedura.test',
};
const links = new AppLinks({
  get: (key: string) => ENV[key],
} as unknown as ConfigService);

interface Harness {
  service: BillingEmailService;
  queue: FakeQueue;
  outbox: EmailOutboxService;
  emitter: Record<string, jest.Mock>;
  prefs: { shouldSend: jest.Mock };
  claimed: Set<string>;
  deliver: jest.Mock;
  once: { claim: jest.Mock; release: jest.Mock };
  recipients: { user: jest.Mock; workspace: jest.Mock };
}

function harness(
  overrides: { notify?: NotifyService; allowApp?: boolean } = {},
): Harness {
  const queue = new FakeQueue();
  const prefs = { shouldSend: jest.fn().mockResolvedValue(true) };
  const deliver = jest
    .fn()
    .mockResolvedValue({ success: true, messageId: 'm' });
  const outbox = new EmailOutboxService(
    queue as unknown as Queue,
    { deliver } as unknown as EmailService,
    prefs as never,
    { isSuppressed: jest.fn().mockResolvedValue(false) } as never,
    new EmailFooterService(links, {} as never, {} as never),
    links,
    {} as never,
  );
  const recipients = {
    user: jest.fn().mockResolvedValue({
      id: USER_ID,
      email: ADDRESS,
      name: 'Owner',
    } satisfies Recipient),
    workspace: jest.fn().mockResolvedValue({
      id: WS_ID,
      name: 'Rehman Workspace',
      timezone: 'Asia/Karachi',
    }),
  };
  const notify =
    overrides.notify ??
    new RealNotifyService(prefs as never, outbox, recipients as never);
  prefs.shouldSend.mockImplementation((_u, _w, _e, channel: string) =>
    Promise.resolve(channel === 'app' ? (overrides.allowApp ?? true) : true),
  );
  const claimed = new Set<string>();
  const once = {
    claim: jest.fn((key: string) => {
      if (claimed.has(key)) return Promise.resolve(false);
      claimed.add(key);
      return Promise.resolve(true);
    }),
    release: jest.fn((key: string) => {
      claimed.delete(key);
      return Promise.resolve();
    }),
  };
  const emitter = {
    paymentFailed: jest.fn().mockResolvedValue(undefined),
    subscriptionExpiring: jest.fn().mockResolvedValue(undefined),
    planChanged: jest.fn().mockResolvedValue(undefined),
  };
  const service = new BillingEmailService(
    fakeDb(),
    notify,
    recipients as unknown as RecipientsService,
    once as never,
    links,
    emitter as never,
    outbox,
  );
  return {
    service,
    queue,
    outbox,
    emitter,
    prefs,
    claimed,
    deliver,
    once,
    recipients,
  };
}

const failedInput = {
  userId: USER_ID,
  planName: 'Pro',
  amountCents: 2900,
  currency: 'usd',
  cardLast4: '4242',
  cardBrand: 'visa',
  reason: 'Your card has insufficient funds.',
  nextAttempt: new Date('2026-10-29T08:00:00Z'),
  dedupeKey: 'payment-failed.in_123.2',
};

async function renderJob(
  queue: FakeQueue,
  jobId: string,
): Promise<{ subject: string; html: string; text: string }> {
  const job = queue.jobs.get(jobId);
  if (!job) throw new Error(`no job ${jobId}`);
  return renderEmail(getTemplate(job.data.template), job.data.props, {
    assetBaseUrl: 'https://app.schedura.test/email',
    footer: { reason: 'Why', links: [] },
  });
}

beforeEach(() => {
  tables = {
    users: [{ lastAccessedWorkspaceId: WS_ID }],
    workspace: [{ id: WS_ID }],
    plans: PLANS,
  };
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('BillingEmailService.paymentFailed (D1)', () => {
  it('renders the amount, the card and the next try', async () => {
    const h = harness();
    await h.service.paymentFailed(failedInput);

    const mail = await renderJob(h.queue, 'payment-failed.in_123.2');
    expect(mail.subject).toBe(
      'Your payment for Schedura Pro didn’t go through',
    );
    expect(mail.html).toContain('$29.00');
    expect(mail.html).toContain('Visa •• 4242');
    expect(mail.html).toContain('Next try');
    expect(mail.html).toContain('Oct 29, 2026');
    expect(mail.html).toContain(
      'Your bank said: Your card has insufficient funds.',
    );
    expect(mail.html).toContain('only 3 channels keep publishing.');
    expect(mail.html).toContain('Update card');
    expect(h.queue.jobs.get('payment-failed.in_123.2')?.data.to).toEqual({
      email: ADDRESS,
      userId: USER_ID,
    });
  });

  it('omits Next try, the card and the reason when they are not known', async () => {
    const h = harness();
    await h.service.paymentFailed({
      ...failedInput,
      nextAttempt: null,
      cardLast4: null,
      cardBrand: null,
      reason: null,
    });

    const mail = await renderJob(h.queue, 'payment-failed.in_123.2');
    expect(mail.html).not.toContain('Next try');
    expect(mail.html).not.toContain('Card');
    expect(mail.html).not.toContain('Your bank said');
  });

  it('delivering the same failure twice enqueues one job; the next attempt is a new one', async () => {
    const h = harness();
    await h.service.paymentFailed(failedInput);
    await h.service.paymentFailed(failedInput);
    expect([...h.queue.jobs.keys()]).toEqual(['payment-failed.in_123.2']);

    await h.service.paymentFailed({
      ...failedInput,
      dedupeKey: 'payment-failed.in_123.3',
    });
    expect([...h.queue.jobs.keys()]).toEqual([
      'payment-failed.in_123.2',
      'payment-failed.in_123.3',
    ]);
  });

  it('rings the bell with dollars and the reason, only when the app preference allows', async () => {
    const on = harness();
    await on.service.paymentFailed(failedInput);
    expect(on.emitter.paymentFailed).toHaveBeenCalledWith(
      USER_ID,
      29,
      'Your card has insufficient funds.',
    );
    expect(on.prefs.shouldSend).toHaveBeenCalledWith(
      USER_ID,
      WS_ID,
      'billing_alert',
      'app',
    );

    const off = harness({ allowApp: false });
    await off.service.paymentFailed(failedInput);
    expect(off.emitter.paymentFailed).not.toHaveBeenCalled();
    // The email is mandatory: switching the bell off never stops it.
    expect(off.queue.jobs.size).toBe(1);
  });

  it('billing mail carries no List-Unsubscribe and its footer says it cannot be turned off', async () => {
    const h = harness();
    await h.service.paymentFailed(failedInput);
    const data = h.queue.jobs.get('payment-failed.in_123.2')?.data;

    await expect(h.outbox.process(data as EmailJobData)).resolves.toBe('sent');

    const [message, options] = h.deliver.mock.calls[0] as [
      { html: string; headers?: Record<string, string> },
      { tags: { category: string } },
    ];
    expect(message.headers).toBeUndefined();
    expect(message.html).toContain(
      'Billing emails go to workspace owners and can’t be turned off.',
    );
    expect(options.tags.category).toBe('billing');
  });

  it('never throws and never logs the address when the pipeline fails', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const notify = {
      notify: jest.fn().mockRejectedValue(new Error('redis is down')),
    } as unknown as NotifyService;
    const h = harness({ notify });

    await expect(h.service.paymentFailed(failedInput)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    for (const call of warn.mock.calls) {
      expect(String(call[0])).not.toContain(ADDRESS);
    }
  });
});

describe('BillingEmailService.trialEnding (D2)', () => {
  const trialEnd = new Date('2026-11-02T10:00:00Z');
  const input = {
    userId: USER_ID,
    subscriptionId: 42,
    trialEnd,
    planCode: 'PRO',
    hasCard: false,
  };
  const key = `trial-ending.42.${trialEnd.getTime()}`;

  beforeEach(() => {
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-10-30T10:00:00Z').getTime());
  });

  it('shows what changes on Free and the no-card sentence', async () => {
    const h = harness();
    await h.service.trialEnding(input);

    const mail = await renderJob(h.queue, key);
    expect(mail.subject).toBe('Your Pro trial ends on Nov 2, 2026');
    expect(mail.html).toContain('Your Pro trial ends in 3 days');
    expect(mail.html).toContain('What changes on Free');
    expect(mail.html).toContain('8 → 3 publishing');
    expect(mail.html).toContain('5 → 1');
    expect(mail.html).toContain('2,000 → 0 a month');
    expect(mail.html).toContain('All kept');
    expect(mail.html).toContain(
      'No card is on file, so nothing is charged automatically.',
    );
    expect(h.emitter.subscriptionExpiring).toHaveBeenCalledWith(
      USER_ID,
      3,
      'Pro',
    );
  });

  it('says the plan renews when a card is on file or the provider is unsure', async () => {
    for (const hasCard of [true, null]) {
      const h = harness();
      await h.service.trialEnding({ ...input, hasCard });
      const mail = await renderJob(h.queue, key);
      expect(mail.html).toContain(
        'If you do nothing, Pro renews on Nov 2, 2026.',
      );
      expect(mail.html).not.toContain('No card is on file');
    }
  });

  it('renders -1 as Unlimited', async () => {
    const h = harness();
    await h.service.trialEnding({ ...input, planCode: 'MAX' });
    const mail = await renderJob(h.queue, key);
    expect(mail.html).toContain('Unlimited → 3 publishing');
    expect(mail.html).toContain('Unlimited → 0 a month');
  });

  it('claims the trial once: a second call sends nothing', async () => {
    const h = harness();
    await h.service.trialEnding(input);
    await h.service.trialEnding(input);
    expect(h.queue.jobs.size).toBe(1);
    expect(h.emitter.subscriptionExpiring).toHaveBeenCalledTimes(1);
  });

  it('a failed enqueue gives the claim back, so the next run still sends', async () => {
    const h = harness();
    h.queue.failNext = new Error('redis is down');

    await h.service.trialEnding(input);

    expect(h.queue.jobs.size).toBe(0);
    expect(h.once.release).toHaveBeenCalledWith(key);
    expect(h.claimed.size).toBe(0);
    // No bell for a mail that never went out.
    expect(h.emitter.subscriptionExpiring).not.toHaveBeenCalled();

    await h.service.trialEnding(input);
    expect(h.queue.jobs.size).toBe(1);
    expect(h.emitter.subscriptionExpiring).toHaveBeenCalledTimes(1);
  });

  it('an enqueue that times out ("not queued") gives the claim back and rings no bell', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      const h = harness();
      h.queue.hangNext = true;

      const run = h.service.trialEnding(input);
      await jest.advanceTimersByTimeAsync(5000);
      await run;

      expect(h.queue.jobs.size).toBe(0);
      expect(h.once.release).toHaveBeenCalledWith(key);
      expect(h.claimed.size).toBe(0);
      expect(h.emitter.subscriptionExpiring).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('reads everything it needs before claiming: a failed read leaves the trial unclaimed', async () => {
    const h = harness();
    h.recipients.user.mockRejectedValueOnce(new Error('db is down'));

    await h.service.trialEnding(input);

    expect(h.once.claim).not.toHaveBeenCalled();
    expect(h.claimed.size).toBe(0);

    await h.service.trialEnding(input);
    expect(h.queue.jobs.size).toBe(1);
  });

  it('does not claim when the plan is unknown, so a later fix can still send', async () => {
    const h = harness();
    await h.service.trialEnding({ ...input, planCode: 'NOPE' });
    expect(h.queue.jobs.size).toBe(0);
    expect(h.claimed.size).toBe(0);
  });
});

describe('BillingEmailService.planChanged (D3)', () => {
  const base = {
    userId: USER_ID,
    fromPlan: 'Pro',
    toPlan: 'Max',
    billed: '$49 monthly',
    nextCharge: new Date('2026-11-26T08:00:00Z'),
    endsOn: null,
    dedupeKey: 'plan-changed.u.upgraded.sub_1.1',
  };

  it('upgrades: heading, rows and the Stripe receipt sentence for Stripe only', async () => {
    const stripe = harness();
    await stripe.service.planChanged({
      ...base,
      kind: 'upgraded',
      provider: 'stripe',
    });
    const mail = await renderJob(stripe.queue, base.dedupeKey);
    expect(mail.subject).toBe('You’re now on Schedura Max');
    expect(mail.html).toContain('You’re on Schedura Max');
    expect(mail.html).toContain('Pro → Max');
    expect(mail.html).toContain('$49 monthly');
    expect(mail.html).toContain('Nov 26, 2026');
    expect(mail.html).toContain(
      'Stripe sends the receipt in a separate email.',
    );
    expect(mail.html).toContain('Manage billing');
    expect(stripe.emitter.planChanged).toHaveBeenCalledWith(
      USER_ID,
      'Pro',
      'Max',
    );

    const ls = harness();
    await ls.service.planChanged({
      ...base,
      kind: 'upgraded',
      provider: 'lemonsqueezy',
    });
    const lsMail = await renderJob(ls.queue, base.dedupeKey);
    expect(lsMail.html).not.toContain('Stripe sends the receipt');

    const downgrade = harness();
    await downgrade.service.planChanged({
      ...base,
      kind: 'downgraded',
      provider: 'stripe',
    });
    expect(
      (await renderJob(downgrade.queue, base.dedupeKey)).html,
    ).not.toContain('Stripe sends the receipt');
  });

  it.each([
    [
      'cancel_scheduled',
      'Your Pro plan ends on Nov 30, 2026',
      'Your Pro plan ends on Nov 30, 2026',
      'Your workspaces move to Free on Nov 30, 2026. Nothing is deleted.',
    ],
    [
      'ended',
      'You’re on Schedura Free',
      'Your Schedura Pro plan has ended',
      null,
    ],
    [
      'payment_restricted',
      'Your workspaces moved to Free',
      'Your workspaces moved to Free',
      'We couldn’t collect payment for Schedura Pro after 3 tries. Update your card to switch back.',
    ],
  ])('%s: heading, subject and body', async (kind, heading, subject, text) => {
    const h = harness();
    await h.service.planChanged({
      ...base,
      kind: kind as 'ended',
      toPlan: 'Free',
      billed: null,
      nextCharge: null,
      endsOn: new Date('2026-11-30T08:00:00Z'),
    });
    const mail = await renderJob(h.queue, base.dedupeKey);
    expect(mail.subject).toBe(subject.replace('&#x27;', "'"));
    expect(mail.html).toContain(heading);
    if (text) expect(mail.html).toContain(text);
    expect(mail.html).toContain(
      kind === 'payment_restricted' ? 'Update card' : 'Manage billing',
    );
    // No bell for these: the in-app planChanged exists for plan switches only.
    expect(h.emitter.planChanged).not.toHaveBeenCalled();
  });

  it('a scheduled downgrade says the plan changes later, never that it already has', async () => {
    const h = harness();
    await h.service.planChanged({
      ...base,
      kind: 'downgrade_scheduled',
      fromPlan: 'Max',
      toPlan: 'Pro',
      billed: '$29 monthly',
      nextCharge: null,
      endsOn: new Date('2026-11-30T08:00:00Z'),
      provider: 'stripe',
    });

    const mail = await renderJob(h.queue, base.dedupeKey);
    expect(mail.subject).toBe(
      'Your plan changes to Schedura Pro on Nov 30, 2026',
    );
    expect(mail.html).toContain(
      'Your plan changes to Schedura Pro on Nov 30, 2026',
    );
    expect(mail.html).toContain('Until then you keep everything in Max.');
    expect(mail.html).toContain('Changes on');
    expect(mail.html).toContain('Max → Pro');
    expect(mail.html).toContain('$29 monthly');
    expect(mail.html).toContain('Manage billing');
    expect(mail.html).not.toContain('You’re on Schedura');
    expect(mail.html).not.toContain('now allow');
    expect(mail.html).not.toContain('Stripe sends the receipt');
    // The in-app "Plan Updated" bell this site always rang is kept.
    expect(h.emitter.planChanged).toHaveBeenCalledWith(USER_ID, 'Max', 'Pro');
  });

  it('a lemon squeezy cancel without an end date still reads', async () => {
    const h = harness();
    await h.service.planChanged({
      ...base,
      kind: 'cancel_scheduled',
      toPlan: 'Free',
      endsOn: null,
    });
    const mail = await renderJob(h.queue, base.dedupeKey);
    expect(mail.html).toContain('Your Pro plan is set to end');
  });

  it('never throws when the database fails', async () => {
    const h = harness();
    tables = undefined as never; // every select now throws
    await expect(
      h.service.planChanged({ ...base, kind: 'upgraded' }),
    ).resolves.toBeUndefined();
  });
});

describe('workspace choice and helpers', () => {
  it('falls back to the first owned workspace when the last opened one is gone', async () => {
    const h = harness();
    tables.users = [{ lastAccessedWorkspaceId: null }];
    tables.workspace = [{ id: WS_ID }];
    await h.service.paymentFailed(failedInput);
    const mail = await renderJob(h.queue, 'payment-failed.in_123.2');
    expect(mail.html).toContain(`/w/${WS_ID}/settings/billing`);
  });

  it('still sends, with the app root link, when the user owns no workspace', async () => {
    const h = harness();
    tables.users = [{ lastAccessedWorkspaceId: null }];
    tables.workspace = [];
    await h.service.paymentFailed(failedInput);
    const mail = await renderJob(h.queue, 'payment-failed.in_123.2');
    expect(mail.html).toContain('href="https://app.schedura.test/"');
  });

  it('planName resolves a plan code to its name, else returns the code', async () => {
    const h = harness();
    await expect(h.service.planName('PRO')).resolves.toBe('Pro');
    await expect(h.service.planName('LEGACY')).resolves.toBe('LEGACY');
  });

  it('billingEmailKey keeps only characters an idempotency key may hold', () => {
    const key = billingEmailKey('plan-changed', 'a:b c', 42, 'sub_1');
    expect(key).toBe('plan-changed.a_b_c.42.sub_1');
    expect(key).toMatch(IDEMPOTENCY_KEY_RE);
  });

  it('formatMoney formats a currency and survives an invalid code', () => {
    expect(formatMoney(2900, 'usd')).toBe('$29.00');
    expect(formatMoney(2900, 'not a code')).toBe('29.00 NOT A CODE');
  });
});
