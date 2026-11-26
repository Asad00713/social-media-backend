import { Logger } from '@nestjs/common';
import { TrialEndingCron } from './trial-ending.cron';

/**
 * A select chain that resolves to fixed rows, whatever the clauses say.
 *
 * `sendDue` runs TWO selects: the trials inside the window, then which of
 * them a swept provider bills the plan for. This fake answers them in order,
 * because it cannot read a where clause to tell them apart — a deliberate
 * limit, not an oversight: what WHICH subscriptions are asked for is tested
 * against the real table-aware fake in `trial-ending.cron.providers.spec.ts`.
 * Here the second answer simply confirms every candidate, so these tests stay
 * about what happens to a due trial once it is found.
 */
function dbReturning(rows: unknown[]): never {
  const answers = [
    rows,
    (rows as { id: unknown }[]).map((row) => ({ subscriptionId: row.id })),
  ];
  let call = 0;
  const chain: Record<string, unknown> = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(answers[Math.min(call++, answers.length - 1)]).then(
        resolve,
      ),
  };
  return { select: () => chain } as never;
}

const TRIAL_END = new Date('2026-11-17T09:00:00Z');

describe('TrialEndingCron', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('hands each due trial to the email service without a card claim', async () => {
    const billingEmail = {
      trialEnding: jest.fn().mockResolvedValue(undefined),
    };
    const cron = new TrialEndingCron(
      dbReturning([
        { id: 1, userId: 'u1', planCode: 'PRO', trialEnd: TRIAL_END },
        { id: 2, userId: 'u2', planCode: 'MAX', trialEnd: TRIAL_END },
      ]),
      billingEmail as never,
    );

    await expect(cron.sendDue(new Date('2026-11-14T09:00:00Z'))).resolves.toBe(
      2,
    );

    const handed = (billingEmail.trialEnding.mock.calls as unknown[][]).map(
      (call) => call[0],
    );
    expect(handed).toEqual([
      {
        userId: 'u1',
        subscriptionId: 1,
        trialEnd: TRIAL_END,
        planCode: 'PRO',
        hasCard: null,
      },
      {
        userId: 'u2',
        subscriptionId: 2,
        trialEnd: TRIAL_END,
        planCode: 'MAX',
        hasCard: null,
      },
    ]);
  });

  it("one account's failure does not stop the others", async () => {
    const billingEmail = {
      trialEnding: jest
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue(undefined),
    };
    const cron = new TrialEndingCron(
      dbReturning([
        { id: 1, userId: 'u1', planCode: 'PRO', trialEnd: TRIAL_END },
        { id: 2, userId: 'u2', planCode: 'PRO', trialEnd: TRIAL_END },
      ]),
      billingEmail as never,
    );

    await expect(cron.sendDue()).resolves.toBe(1);
    expect(billingEmail.trialEnding).toHaveBeenCalledTimes(2);
  });

  it('skips a row with no trial end and does nothing when nothing is due', async () => {
    const billingEmail = { trialEnding: jest.fn() };

    await new TrialEndingCron(
      dbReturning([{ id: 1, userId: 'u1', planCode: 'PRO', trialEnd: null }]),
      billingEmail as never,
    ).sendDue();
    await new TrialEndingCron(dbReturning([]), billingEmail as never).sendDue();

    expect(billingEmail.trialEnding).not.toHaveBeenCalled();
  });

  it('runs daily at 09:00 UTC under its own name', () => {
    const cron = Reflect.getMetadata(
      'SCHEDULE_CRON_OPTIONS',
      // eslint-disable-next-line @typescript-eslint/unbound-method -- metadata is read off the function, never called
      TrialEndingCron.prototype.nightly,
    ) as { name: string; timeZone: string; cronTime: string };
    expect(cron).toMatchObject({
      name: 'lsTrialEnding',
      timeZone: 'UTC',
      cronTime: '0 9 * * *',
    });
  });
});
