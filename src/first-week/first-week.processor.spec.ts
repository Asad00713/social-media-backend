import { FirstWeekProcessor, isFinalAttempt } from './first-week.processor';
import { FirstWeekQueueService } from './first-week-queue.service';

describe('isFinalAttempt', () => {
  it.each([
    [{ attemptsMade: 1, opts: { attempts: 3 } }, false],
    [{ attemptsMade: 2, opts: { attempts: 3 } }, false],
    [{ attemptsMade: 3, opts: { attempts: 3 } }, true],
    [{ attemptsMade: 1, opts: {} }, true], // no retries configured: the first failure is final
  ])('%j -> %s', (job, expected) => {
    expect(isFinalAttempt(job)).toBe(expected);
  });
});

describe('FirstWeekQueueService.jobIdFor', () => {
  it('has no colon (BullMQ rejects colons in custom job ids)', () => {
    const id = FirstWeekQueueService.jobIdFor(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(id).toBe('first-week-11111111-1111-4111-8111-111111111111');
    expect(id).not.toContain(':');
  });
});

describe('FirstWeekProcessor', () => {
  const data = { workspaceId: 'w1', mode: 'posts' as const };
  const make = () => {
    const run = {
      execute: jest.fn(async () => 'ready'),
      markFailed: jest.fn(async () => undefined),
    };
    return { run, proc: new FirstWeekProcessor(run as any) };
  };

  it('runs the job payload', async () => {
    const { run, proc } = make();
    expect(await proc.process({ data } as any)).toBe('ready');
    expect(run.execute).toHaveBeenCalledWith(data);
  });

  it('does not mark failed while retries remain', async () => {
    const { run, proc } = make();
    await proc.onFailed(
      { data, attemptsMade: 1, opts: { attempts: 3 } } as any,
      new Error('boom'),
    );
    expect(run.markFailed).not.toHaveBeenCalled();
  });

  it('marks failed, with the error message, after the final attempt', async () => {
    const { run, proc } = make();
    await proc.onFailed(
      { data, attemptsMade: 3, opts: { attempts: 3 } } as any,
      new Error('boom'),
    );
    expect(run.markFailed).toHaveBeenCalledWith('w1', 'boom');
  });

  it('survives markFailed itself failing', async () => {
    const { run, proc } = make();
    run.markFailed.mockRejectedValue(new Error('db down'));
    await expect(
      proc.onFailed(
        { data, attemptsMade: 3, opts: { attempts: 3 } } as any,
        new Error('boom'),
      ),
    ).resolves.toBeUndefined();
  });

  it('ignores a failed event with no job', async () => {
    const { run, proc } = make();
    await proc.onFailed(undefined, new Error('boom'));
    expect(run.markFailed).not.toHaveBeenCalled();
  });
});
