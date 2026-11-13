import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { ReportsScheduler } from './reports.scheduler';
import type { ReportsRepository } from './reports.repository';

const A = '5d0b6f0e-1111-4222-8333-944455556666';
const B = '7a1b2c3d-1111-4222-8333-944455556666';
const NOW = new Date('2026-11-16T04:07:00Z');

type FakeJob = { getState: () => Promise<string>; remove: jest.Mock };

function make(
  due: { id: string; nextRunAt: Date }[],
  existing: Record<string, FakeJob> = {},
) {
  const repo = { due: jest.fn(() => Promise.resolve(due)) };
  const queue = {
    add: jest.fn(() => Promise.resolve()),
    getJob: jest.fn((id: string) => Promise.resolve(existing[id])),
  };
  return {
    repo,
    queue,
    scheduler: new ReportsScheduler(
      repo as unknown as ReportsRepository,
      queue as unknown as Queue,
    ),
  };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('ReportsScheduler.enqueueDue', () => {
  it('queues each due report once, two seconds apart', async () => {
    const { scheduler, queue, repo } = make([
      { id: A, nextRunAt: new Date('2026-11-16T04:00:00Z') },
      { id: B, nextRunAt: new Date('2026-11-16T04:00:00Z') },
    ]);
    await expect(scheduler.enqueueDue(NOW)).resolves.toBe(2);
    expect(repo.due).toHaveBeenCalledWith(NOW);
    expect(queue.add).toHaveBeenCalledTimes(2);

    const calls = queue.add.mock.calls as unknown as [
      string,
      { reportId: string; kind: string },
      { jobId: string; delay: number },
    ][];
    expect(calls.map((c) => c[0])).toEqual(['report-send', 'report-send']);
    expect(calls.map((c) => c[1])).toEqual([
      { reportId: A, kind: 'scheduled' },
      { reportId: B, kind: 'scheduled' },
    ]);
    expect(calls.map((c) => c[2].delay)).toEqual([0, 2000]);
    for (const [, , opts] of calls) {
      expect(opts.jobId).toMatch(/^report-[0-9a-f-]{36}-\d{12}$/);
      expect(opts.jobId).not.toContain(':');
    }
    expect(calls[0][2].jobId).toBe(`report-${A}-202611160400`);
  });

  it('queues nothing when nothing is due', async () => {
    const { scheduler, queue } = make([]);
    await expect(scheduler.enqueueDue(NOW)).resolves.toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  describe('a slot job that already ran but left the report due', () => {
    const SLOT = `report-${A}-202611160400`;
    const due = [{ id: A, nextRunAt: new Date('2026-11-16T04:00:00Z') }];
    const job = (state: string): FakeJob => ({
      getState: () => Promise.resolve(state),
      remove: jest.fn(() => Promise.resolve()),
    });

    it.each(['failed', 'completed'])(
      'removes the %s job and queues the slot again',
      async (state) => {
        const stuck = job(state);
        const { scheduler, queue } = make(due, { [SLOT]: stuck });
        await scheduler.enqueueDue(NOW);
        expect(stuck.remove).toHaveBeenCalledTimes(1);
        expect(queue.add).toHaveBeenCalledTimes(1);
        const [, , opts] = queue.add.mock.calls[0] as unknown as [
          string,
          unknown,
          { jobId: string },
        ];
        expect(opts.jobId).toBe(SLOT);
      },
    );

    it.each(['waiting', 'active', 'delayed'])(
      'leaves a %s job alone',
      async (state) => {
        const live = job(state);
        const { scheduler, queue } = make(due, { [SLOT]: live });
        await scheduler.enqueueDue(NOW);
        expect(live.remove).not.toHaveBeenCalled();
        expect(queue.add).toHaveBeenCalledTimes(1);
      },
    );
  });
});
