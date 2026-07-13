// The webhook controller reads `calendar_sync_state` through the module-level
// `db` singleton (not DI), so jest.mock the module and drive the exact lookup
// each provider callback performs.
jest.mock('../drizzle/db', () => {
  const selectResult: { rows: unknown[] } = { rows: [] };
  return {
    __selectResult: selectResult,
    db: {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => Promise.resolve(selectResult.rows)),
        })),
      })),
    },
  };
});

import type { Response } from 'express';
import type { Queue } from 'bullmq';
import { CalendarWebhookController } from './calendar-webhook.controller';
import {
  CALENDAR_RECONCILE_JOB,
  CALENDAR_WEBHOOK_DEBOUNCE_MS,
} from './calendar-sync.constants';
import { deriveCalendarWebhookSecret } from './calendar-webhook.util';

const dbMock = jest.requireMock('../drizzle/db') as unknown as {
  __selectResult: { rows: unknown[] };
};

const CHANNEL_ID = 42;

// The per-channel secret is derived (never stored) from this env var — the util
// reads it lazily, so setting it here is enough to compute the exact value a
// provider would echo back.
process.env.CALENDAR_WEBHOOK_HMAC_SECRET = 'unit-test-secret';

const VALID_SECRET = deriveCalendarWebhookSecret(CHANNEL_ID);

const GOOGLE_STATE = {
  id: 'state-1',
  channelId: CHANNEL_ID,
  provider: 'google',
  watchChannelId: 'watch-abc',
  watchResourceId: 'res-abc',
  subscriptionId: null,
};

const OUTLOOK_STATE = {
  id: 'state-2',
  channelId: CHANNEL_ID,
  provider: 'outlook',
  watchChannelId: null,
  subscriptionId: 'sub-abc',
};

interface ResMock {
  status: jest.Mock;
  type: jest.Mock;
  send: jest.Mock;
  json: jest.Mock;
}

/** Minimal express Response double — every method is chainable. */
function makeRes(): ResMock {
  const res: ResMock = {
    status: jest.fn(),
    type: jest.fn(),
    send: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.type.mockReturnValue(res);
  res.send.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

/** The (name, data, opts) triple of the Nth (default: first) enqueued job. */
function enqueuedJob(
  queue: { add: jest.Mock },
  index = 0,
): {
  name: string;
  data: { channelId: number };
  opts: { jobId: string; delay: number };
} {
  const [name, data, opts] = queue.add.mock.calls[index] as [
    string,
    { channelId: number },
    { jobId: string; delay: number },
  ];
  return { name, data, opts };
}

describe('CalendarWebhookController', () => {
  let queue: { add: jest.Mock };
  let controller: CalendarWebhookController;

  beforeEach(() => {
    jest.clearAllMocks();
    dbMock.__selectResult.rows = [];
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    controller = new CalendarWebhookController(queue as unknown as Queue);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ==========================================================================
  // Microsoft Graph
  // ==========================================================================

  it('echoes the Graph validationToken back as raw text/plain with 200 and enqueues nothing', async () => {
    const res = makeRes();

    await controller.handleOutlook(
      'Validation: Testing client',
      {},
      res as unknown as Response,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.type).toHaveBeenCalledWith('text/plain');
    expect(res.send).toHaveBeenCalledWith('Validation: Testing client');
    expect(res.json).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('ignores a Graph notification whose clientState does not match (no enqueue, still 202)', async () => {
    dbMock.__selectResult.rows = [OUTLOOK_STATE];
    const res = makeRes();

    await controller.handleOutlook(
      undefined,
      { value: [{ subscriptionId: 'sub-abc', clientState: 'forged-secret' }] },
      res as unknown as Response,
    );

    expect(queue.add).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('enqueues a reconcile for a Graph notification with a valid clientState', async () => {
    dbMock.__selectResult.rows = [OUTLOOK_STATE];
    const res = makeRes();

    await controller.handleOutlook(
      undefined,
      { value: [{ subscriptionId: 'sub-abc', clientState: VALID_SECRET }] },
      res as unknown as Response,
    );

    expect(queue.add).toHaveBeenCalledTimes(1);
    const job = enqueuedJob(queue);
    expect(job.name).toBe(CALENDAR_RECONCILE_JOB);
    expect(job.data).toEqual({ channelId: CHANNEL_ID });
    expect(job.opts.jobId).toContain(`calendar-reconcile-${CHANNEL_ID}-hook-`);
    expect(res.status).toHaveBeenCalledWith(202);
  });

  // ==========================================================================
  // Google
  // ==========================================================================

  it('treats the Google "sync" resource state as a handshake (no enqueue)', async () => {
    dbMock.__selectResult.rows = [GOOGLE_STATE];

    const result = await controller.handleGoogle(
      'watch-abc',
      VALID_SECRET,
      'sync',
    );

    expect(result).toEqual({ status: 'ok' });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('enqueues a reconcile for the mapped channel on a valid Google notification', async () => {
    dbMock.__selectResult.rows = [GOOGLE_STATE];

    const result = await controller.handleGoogle(
      'watch-abc',
      VALID_SECRET,
      'exists',
    );

    expect(result).toEqual({ status: 'ok' });
    expect(queue.add).toHaveBeenCalledTimes(1);
    const job = enqueuedJob(queue);
    expect(job.name).toBe(CALENDAR_RECONCILE_JOB);
    expect(job.data).toEqual({ channelId: CHANNEL_ID });
    expect(job.opts.jobId).toContain(`calendar-reconcile-${CHANNEL_ID}-hook-`);
  });

  it('ignores a Google notification whose channel token does not match', async () => {
    dbMock.__selectResult.rows = [GOOGLE_STATE];

    const result = await controller.handleGoogle(
      'watch-abc',
      'forged-token',
      'exists',
    );

    expect(result).toEqual({ status: 'ignored' });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('ignores (2xx, no enqueue) a Google notification for an unknown watch channel', async () => {
    dbMock.__selectResult.rows = [];

    const result = await controller.handleGoogle(
      'watch-unknown',
      VALID_SECRET,
      'exists',
    );

    expect(result).toEqual({ status: 'ignored' });
    expect(queue.add).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Regression: handleGoogle had no try/catch, so a DB or Redis blip escaped as
  // a 500. Google DISABLES a push channel after sustained failures, which would
  // silently kill two-way sync for that connection.
  // ---------------------------------------------------------------------------
  it('answers 2xx (never 5xx) when an internal error is thrown while handling a Google notification', async () => {
    dbMock.__selectResult.rows = [GOOGLE_STATE];
    // Redis blip on the enqueue.
    queue.add.mockRejectedValueOnce(new Error('redis is unreachable'));

    await expect(
      controller.handleGoogle('watch-abc', VALID_SECRET, 'exists'),
    ).resolves.toEqual({ status: 'ignored' });
  });

  // ---------------------------------------------------------------------------
  // Regression: the jobId was keyed on Date.now(), so it only deduped inside the
  // SAME millisecond. Google sends ONE notification per changed event, so a bulk
  // change fanned out into one FULL delta pull per event.
  // ---------------------------------------------------------------------------
  it('coalesces a burst of Google notifications into ONE bucketed, delayed reconcile job', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    dbMock.__selectResult.rows = [GOOGLE_STATE];

    await controller.handleGoogle('watch-abc', VALID_SECRET, 'exists');
    // A second notification 20s later — still inside the same 30s bucket.
    jest.setSystemTime(new Date('2026-07-13T10:00:20.000Z'));
    await controller.handleGoogle('watch-abc', VALID_SECRET, 'exists');

    const first = enqueuedJob(queue, 0);
    const second = enqueuedJob(queue, 1);

    const bucket = Math.floor(
      Date.parse('2026-07-13T10:00:00.000Z') / CALENDAR_WEBHOOK_DEBOUNCE_MS,
    );

    // Identical jobId → BullMQ drops the duplicate, so the burst becomes ONE pull.
    expect(first.opts.jobId).toBe(
      `calendar-reconcile-${CHANNEL_ID}-hook-${bucket}`,
    );
    expect(second.opts.jobId).toBe(first.opts.jobId);

    // Both are delayed to the SAME bucket boundary, so the job is still sitting
    // in the delayed set (and therefore still dedupes) for the whole window.
    expect(first.opts.delay).toBe(CALENDAR_WEBHOOK_DEBOUNCE_MS);
    expect(second.opts.delay).toBe(10_000);
  });
});
