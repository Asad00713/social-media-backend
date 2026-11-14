import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { createElement } from 'react';
import type { NotificationPreferencesService } from '../../notification-preferences/notification-preferences.service';
import type { EmailResult, EmailService } from '../email.service';
import { AppLinks } from '../links/app-links';
import type { EmailSuppressionRepository } from '../suppression/email-suppression.repository';
import { defineTemplate } from '../templates/define-template';
import type { AnyTemplateDef, EmailTemplateDef } from '../templates/types';
import type { EmailFooterService } from './email-footer.service';
import {
  EMAIL_JOB_SEND,
  RetryableEmailError,
  type EmailJobData,
  type EnqueueEmail,
} from './email-job';
import { EmailOutboxService } from './email-outbox.service';

// The registry holds no templates yet (template tasks register them), so the
// specs register their own defs by id.
const mockTemplates = new Map<string, AnyTemplateDef>();
jest.mock('../templates/registry', () => ({
  getTemplate: (id: string) => {
    const def = mockTemplates.get(id);
    if (!def) throw new Error(`Unknown email template "${id}"`);
    return def;
  },
}));

interface Props {
  title: string;
}

function register<P>(def: EmailTemplateDef<P>): EmailTemplateDef<P> {
  mockTemplates.set(def.id, def);
  return def;
}

const notificationBody = jest.fn((p: Props) =>
  createElement('p', null, `Body ${p.title}`),
);
const postFailed = register(
  defineTemplate<Props>({
    id: 'post-failed',
    category: 'publishing',
    event: 'post_failed',
    footer: 'notification',
    subject: (p) => `Failed: ${p.title}`,
    preheader: () => 'It did not publish.',
    Body: notificationBody,
    fixture: { title: 'T' },
  }),
);
const passwordChanged = register(
  defineTemplate<Props>({
    id: 'password-changed',
    category: 'security',
    event: null,
    footer: 'security',
    subject: () => 'Your password was changed',
    preheader: () => 'If this was you, ignore it.',
    Body: (p) => createElement('p', null, p.title),
    fixture: { title: 'T' },
  }),
);
const welcome = register(
  defineTemplate<Props>({
    id: 'welcome',
    category: 'lifecycle',
    event: null,
    footer: 'plain',
    footerReason: () => 'You signed up.',
    subject: () => 'Welcome',
    preheader: () => 'Three things to do first.',
    Body: (p) => createElement('p', null, p.title),
    fixture: { title: 'T' },
  }),
);

const TO = { email: 'r@acme.com', userId: 'u1' };
const sent: EmailResult = { success: true, messageId: 'm1' };

function make() {
  const queue = { add: jest.fn(() => Promise.resolve({})) };
  const email = {
    deliver: jest.fn<Promise<EmailResult>, Parameters<EmailService['deliver']>>(
      () => Promise.resolve(sent),
    ),
  };
  const prefs = { shouldSend: jest.fn(() => Promise.resolve(true)) };
  const suppressions = { isSuppressed: jest.fn(() => Promise.resolve(false)) };
  const footer = {
    build: jest.fn(() =>
      Promise.resolve({ reason: 'Footer reason line.', links: [] }),
    ),
  };
  const links = new AppLinks({
    get: (_key: string, d?: string) => d,
  } as unknown as ConfigService);
  const outbox = new EmailOutboxService(
    queue as unknown as Queue,
    email as unknown as EmailService,
    prefs as unknown as NotificationPreferencesService,
    suppressions as unknown as EmailSuppressionRepository,
    footer as unknown as EmailFooterService,
    links,
  );
  return { outbox, queue, email, prefs, suppressions, footer };
}

const input: EnqueueEmail<Props> = {
  template: postFailed,
  props: { title: 'Launch' },
  to: TO,
  workspaceId: 'ws1',
  idempotencyKey: 'post-failed.u1.ws1.w1',
};

function job(def: AnyTemplateDef, extra: Partial<EmailJobData> = {}) {
  return {
    template: def.id,
    props: { title: 'Launch' },
    to: TO,
    workspaceId: 'ws1',
    idempotencyKey: `${def.id}.k1`,
    ...extra,
  } as EmailJobData;
}

let log: jest.SpyInstance;
beforeEach(() => {
  notificationBody.mockClear();
  log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => log.mockRestore());

describe('EmailOutboxService.enqueue', () => {
  it('enqueue rejects a key with ":"', () => {
    const { outbox } = make();
    return expect(
      outbox.enqueue({ ...input, idempotencyKey: 'a:b' }),
    ).rejects.toThrow(/idempotency key/);
  });

  it('rejects an empty key and a key over 200 characters', async () => {
    const { outbox, queue } = make();
    await expect(
      outbox.enqueue({ ...input, idempotencyKey: '' }),
    ).rejects.toThrow(/idempotency key/);
    await expect(
      outbox.enqueue({ ...input, idempotencyKey: 'a'.repeat(201) }),
    ).rejects.toThrow(/idempotency key/);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects an all-digit key, which BullMQ refuses as a custom job id', async () => {
    const { outbox, queue } = make();
    await expect(
      outbox.enqueue({ ...input, idempotencyKey: '12345' }),
    ).rejects.toThrow(/idempotency key/);
    expect(queue.add).not.toHaveBeenCalled();
    // Digits next to anything else are fine.
    await outbox.enqueue({ ...input, idempotencyKey: '12345.6' });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('enqueue adds jobId = key, attempts 10, exponential 2000, delay', async () => {
    const { outbox, queue } = make();
    await outbox.enqueue({ ...input, replyTo: 'x@acme.com', delayMs: 60_000 });
    expect(queue.add).toHaveBeenCalledWith(
      EMAIL_JOB_SEND,
      {
        template: 'post-failed',
        props: { title: 'Launch' },
        to: TO,
        workspaceId: 'ws1',
        idempotencyKey: 'post-failed.u1.ws1.w1',
        replyTo: 'x@acme.com',
      },
      {
        jobId: 'post-failed.u1.ws1.w1',
        attempts: 10,
        backoff: { type: 'exponential', delay: 2000 },
        delay: 60_000,
      },
    );
  });

  it('sets no delay when none is asked for', async () => {
    const { outbox, queue } = make();
    await outbox.enqueue(input);
    const calls = queue.add.mock.calls as unknown as [
      string,
      unknown,
      Record<string, unknown>,
    ][];
    expect(calls[0][2]).not.toHaveProperty('delay');
  });
});

describe('EmailOutboxService.process', () => {
  it('renders the template with the footer and delivers it under the key and tags', async () => {
    const { outbox, email, footer } = make();
    await expect(
      outbox.process(job(postFailed, { replyTo: 'x@acme.com' })),
    ).resolves.toBe('sent');

    expect(footer.build).toHaveBeenCalledWith(
      postFailed,
      { title: 'Launch' },
      TO,
      'ws1',
    );
    const [msg, opts] = email.deliver.mock.calls[0];
    expect(msg.to).toBe('r@acme.com');
    expect(msg.subject).toBe('Failed: Launch');
    expect(msg.replyTo).toBe('x@acme.com');
    expect(msg.html).toContain('Body Launch');
    expect(msg.html).toContain('Footer reason line.');
    expect(msg.text).toContain('Body Launch');
    expect(opts).toEqual({
      idempotencyKey: 'post-failed.k1',
      tags: { category: 'publishing', template: 'post-failed' },
    });
  });

  it('process skips on preference off without rendering', async () => {
    const { outbox, email, prefs, footer } = make();
    prefs.shouldSend.mockResolvedValueOnce(false);
    await expect(outbox.process(job(postFailed))).resolves.toBe('skipped:pref');
    expect(prefs.shouldSend).toHaveBeenCalledWith(
      'u1',
      'ws1',
      'post_failed',
      'email',
    );
    expect(notificationBody).not.toHaveBeenCalled();
    expect(footer.build).not.toHaveBeenCalled();
    expect(email.deliver).not.toHaveBeenCalled();
  });

  it('asks no preference for a mandatory template or a non-user recipient', async () => {
    const { outbox, prefs } = make();
    await outbox.process(job(passwordChanged));
    await outbox.process(
      job(postFailed, { to: { email: 'guest@acme.com', userId: null } }),
    );
    expect(prefs.shouldSend).not.toHaveBeenCalled();
  });

  it('process skips suppressed recipients for notification mail but still sends security mail', async () => {
    const { outbox, email, suppressions } = make();
    suppressions.isSuppressed.mockResolvedValue(true);

    await expect(outbox.process(job(postFailed))).resolves.toBe(
      'skipped:suppressed',
    );
    await expect(outbox.process(job(welcome))).resolves.toBe(
      'skipped:suppressed',
    );
    expect(suppressions.isSuppressed).toHaveBeenCalledWith('r@acme.com');
    expect(email.deliver).not.toHaveBeenCalled();

    suppressions.isSuppressed.mockClear();
    await expect(outbox.process(job(passwordChanged))).resolves.toBe('sent');
    expect(suppressions.isSuppressed).not.toHaveBeenCalled();
    expect(email.deliver).toHaveBeenCalledTimes(1);
  });

  it('process throws UnrecoverableError on a validation_error and a plain Error on rate_limit_exceeded', async () => {
    const { outbox, email } = make();
    email.deliver.mockResolvedValueOnce({
      success: false,
      error: 'invalid `to` field',
      retryable: false,
    });
    await expect(outbox.process(job(postFailed))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    email.deliver.mockResolvedValueOnce({
      success: false,
      error: 'Too many requests',
      retryable: true,
    });
    const err = await outbox.process(job(postFailed)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryableEmailError);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toContain('Too many requests');
  });

  it('a BullMQ retry re-sends with the same idempotencyKey', async () => {
    const { outbox, email } = make();
    email.deliver.mockResolvedValueOnce({
      success: false,
      error: 'Unable to fetch data.',
      retryable: true,
    });
    const data = job(postFailed);
    await expect(outbox.process(data)).rejects.toThrow(RetryableEmailError);
    await expect(outbox.process(data, 1)).resolves.toBe('sent');

    expect(email.deliver).toHaveBeenCalledTimes(2);
    const [first, second] = email.deliver.mock.calls.map(([, opts]) => opts);
    expect(first.idempotencyKey).toBe('post-failed.k1');
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('treats invalid_idempotent_request on a retry as already sent', async () => {
    const { outbox, email } = make();
    const used = {
      success: false,
      error: 'This idempotency key has been used on a different request.',
      retryable: false,
      errorCode: 'invalid_idempotent_request',
    };
    email.deliver.mockResolvedValueOnce(used);
    await expect(outbox.process(job(postFailed), 2)).resolves.toBe('sent');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('already sent by an earlier attempt'),
    );

    // On a first attempt the key clash is a caller bug, not a lost response.
    email.deliver.mockResolvedValueOnce(used);
    await expect(outbox.process(job(postFailed), 0)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('fails an unknown template without retrying', async () => {
    const { outbox } = make();
    await expect(
      outbox.process({ ...job(postFailed), template: 'nope' as never }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe('EmailOutboxService.sendNow', () => {
  it('delivers inline, without the queue, and returns the message id', async () => {
    const { outbox, queue, email } = make();
    const res = await outbox.sendNow({
      ...input,
      template: passwordChanged,
      idempotencyKey: 'password-changed.u1.1',
    });
    expect(res).toEqual({ success: true, messageId: 'm1' });
    expect(queue.add).not.toHaveBeenCalled();
    expect(email.deliver.mock.calls[0][1].idempotencyKey).toBe(
      'password-changed.u1.1',
    );
  });

  it('reports a failed send instead of throwing', async () => {
    const { outbox, email } = make();
    email.deliver.mockResolvedValueOnce({
      success: false,
      error: 'Too many requests',
      retryable: true,
    });
    const res = await outbox.sendNow({ ...input, template: passwordChanged });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Too many requests');
    expect(res.retryable).toBe(true);
  });

  it('reports a bad key as a failure', async () => {
    const { outbox, email } = make();
    const res = await outbox.sendNow({ ...input, idempotencyKey: 'a:b' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/idempotency key/);
    expect(email.deliver).not.toHaveBeenCalled();
  });

  it('reports a skipped send as not sent', async () => {
    const { outbox, prefs } = make();
    prefs.shouldSend.mockResolvedValueOnce(false);
    const res = await outbox.sendNow(input);
    expect(res).toEqual({ success: false, error: 'Not sent: skipped:pref' });
  });
});
