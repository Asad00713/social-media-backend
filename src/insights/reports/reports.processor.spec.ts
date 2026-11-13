import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ReportsProcessor } from './reports.processor';
import type { ReportSendJob } from './report-send.service';
import type { ReportSendService } from './report-send.service';

const DATA: ReportSendJob = {
  reportId: '5d0b6f0e-1111-4222-8333-944455556666',
  kind: 'scheduled',
  sent: ['a@x.com'],
};

function make() {
  const send = {
    run: jest.fn(() => Promise.resolve('sent' as const)),
    markFailed: jest.fn(() => Promise.resolve()),
  };
  return {
    send,
    processor: new ReportsProcessor(send as unknown as ReportSendService),
  };
}

const job = (attemptsMade: number) =>
  ({
    id: 'report-x',
    data: DATA,
    attemptsMade,
    opts: { attempts: 3 },
  }) as unknown as Job<ReportSendJob>;

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('ReportsProcessor', () => {
  it('works one job at a time, so the gap between sends holds across reports', () => {
    expect(
      Reflect.getMetadata('bullmq:worker_metadata', ReportsProcessor),
    ).toEqual({
      concurrency: 1,
    });
  });

  it('hands the job to the send service', async () => {
    const { send, processor } = make();
    const j = job(0);
    await expect(processor.process(j)).resolves.toBe('sent');
    expect(send.run).toHaveBeenCalledWith(j);
  });

  it('does not mark the report failed while attempts remain', async () => {
    const { send, processor } = make();
    await processor.onFailed(job(2), new Error('boom'));
    expect(send.markFailed).not.toHaveBeenCalled();
  });

  it('marks the report failed on the last attempt', async () => {
    const { send, processor } = make();
    const error = new Error('boom');
    await processor.onFailed(job(3), error);
    expect(send.markFailed).toHaveBeenCalledWith(DATA, error);
  });

  it('survives a failure to record the failure', async () => {
    const { send, processor } = make();
    send.markFailed.mockRejectedValue(new Error('db down'));
    await expect(
      processor.onFailed(job(3), new Error('boom')),
    ).resolves.toBeUndefined();
  });

  it('ignores a failed event with no job', async () => {
    const { send, processor } = make();
    await processor.onFailed(undefined, new Error('boom'));
    expect(send.markFailed).not.toHaveBeenCalled();
  });
});
