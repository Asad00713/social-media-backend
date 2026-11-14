import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { QUEUES } from '../../queue/queue.module';
import { EMAIL_JOB_SEND, type EmailJobData } from './email-job';
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
  return {
    outbox,
    processor: new EmailProcessor(outbox as unknown as EmailOutboxService),
  };
}

const job = (name: string) => ({ name, data: DATA }) as Job<EmailJobData>;

describe('EmailProcessor', () => {
  it('consumes the email queue at 4 jobs at once and 8 sends a second', () => {
    expect(QUEUES.EMAIL).toBe('email');
    expect(
      Reflect.getMetadata('bullmq:worker_metadata', EmailProcessor),
    ).toEqual({ concurrency: 4, limiter: { max: 8, duration: 1000 } });
  });

  it('hands a send job to the outbox', async () => {
    const { outbox, processor } = make();
    await expect(processor.process(job(EMAIL_JOB_SEND))).resolves.toBe('sent');
    expect(outbox.process).toHaveBeenCalledWith(DATA);
  });

  it('fails an unknown job name without retrying', async () => {
    const { outbox, processor } = make();
    await expect(processor.process(job('mystery'))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(outbox.process).not.toHaveBeenCalled();
  });
});
