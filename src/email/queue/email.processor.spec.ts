import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { QUEUES } from '../../queue/queue.module';
import {
  EMAIL_JOB_SEND,
  RetryableEmailError,
  type EmailJobData,
} from './email-job';
import type { PostFailureBatchService } from '../batching/post-failure-batch.service';
import type { EmailOutboxService } from './email-outbox.service';
import { EmailProcessor } from './email.processor';

const DATA: EmailJobData = {
  template: 'welcome',
  props: {},
  to: { email: 'r@acme.com', userId: 'u1' },
  workspaceId: null,
  idempotencyKey: 'welcome.u1',
};

function make() {
  const outbox = { process: jest.fn(() => Promise.resolve('sent' as const)) };
  const postFailures = {
    flush: jest.fn(() => Promise.resolve('empty' as const)),
  };
  return {
    outbox,
    postFailures,
    processor: new EmailProcessor(
      outbox as unknown as EmailOutboxService,
      postFailures as unknown as PostFailureBatchService,
    ),
  };
}

const job = (name: string, attemptsMade = 0) =>
  ({
    id: 'welcome.u1',
    name,
    data: DATA,
    attemptsMade,
    opts: { attempts: 10 },
  }) as unknown as Job<EmailJobData>;

let error: jest.SpyInstance<void, unknown[]>;
beforeEach(() => {
  error = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('EmailProcessor', () => {
  it('consumes the email queue at 4 jobs at once and 5 sends a second', () => {
    expect(QUEUES.EMAIL).toBe('email');
    expect(
      Reflect.getMetadata('bullmq:worker_metadata', EmailProcessor),
    ).toEqual({ concurrency: 4, limiter: { max: 5, duration: 1000 } });
  });

  it('hands a send job to the outbox with its attempt count', async () => {
    const { outbox, processor } = make();
    await expect(processor.process(job(EMAIL_JOB_SEND, 3))).resolves.toBe(
      'sent',
    );
    expect(outbox.process).toHaveBeenCalledWith(DATA, 3);
  });

  it('hands a post-failed-flush job to the batch with its attempt count', async () => {
    const { outbox, postFailures, processor } = make();
    const flush = {
      id: 'post-failed.u1.w1.1763125200000',
      name: 'post-failed-flush',
      data: { userId: 'u1', workspaceId: 'w1', windowId: '1763125200000' },
      attemptsMade: 2,
      opts: { attempts: 5 },
    } as unknown as Job<EmailJobData>;
    await expect(processor.process(flush)).resolves.toBe('empty');
    expect(postFailures.flush).toHaveBeenCalledWith(
      'u1',
      'w1',
      '1763125200000',
      2,
    );
    expect(outbox.process).not.toHaveBeenCalled();
  });

  it('fails an unknown job name without retrying', async () => {
    const { outbox, processor } = make();
    await expect(processor.process(job('mystery'))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(outbox.process).not.toHaveBeenCalled();
  });
});

describe('EmailProcessor.onFailed', () => {
  it('stays quiet while retryable attempts remain', () => {
    const { processor } = make();
    processor.onFailed(job(EMAIL_JOB_SEND, 4), new RetryableEmailError('429'));
    expect(error).not.toHaveBeenCalled();
  });

  it('logs once at error level on the last attempt', () => {
    const { processor } = make();
    processor.onFailed(
      job(EMAIL_JOB_SEND, 10),
      new RetryableEmailError('Email welcome.u1 (welcome) failed: 429'),
    );
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0][0]);
    expect(line).toContain('welcome.u1');
    expect(line).toContain(EMAIL_JOB_SEND);
    expect(line).toContain('template welcome');
    expect(line).toContain('10 of 10 attempts');
    expect(line).toContain('failed: 429');
    expect(line).not.toContain('r@acme.com');
  });

  it('logs an UnrecoverableError on its first attempt', () => {
    const { processor } = make();
    processor.onFailed(
      job(EMAIL_JOB_SEND, 1),
      new UnrecoverableError('validation_error'),
    );
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('ignores an event with no job', () => {
    const { processor } = make();
    processor.onFailed(undefined, new Error('x'));
    expect(error).not.toHaveBeenCalled();
  });
});
