import type { Queue } from 'bullmq';
import { ReportsScheduler } from './reports.scheduler';
import type { ReportsRepository } from './reports.repository';

const A = '5d0b6f0e-1111-4222-8333-944455556666';
const B = '7a1b2c3d-1111-4222-8333-944455556666';
const NOW = new Date('2026-11-16T04:07:00Z');

function make(due: { id: string; nextRunAt: Date }[]) {
  const repo = { due: jest.fn(() => Promise.resolve(due)) };
  const queue = { add: jest.fn(() => Promise.resolve()) };
  return {
    repo,
    queue,
    scheduler: new ReportsScheduler(
      repo as unknown as ReportsRepository,
      queue as unknown as Queue,
    ),
  };
}

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
});
