import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { createElement } from 'react';
import { JwtService } from '@nestjs/jwt';
import type { NotificationPreferencesService } from '../../notification-preferences/notification-preferences.service';
import type { EmailResult, EmailService } from '../email.service';
import { AppLinks } from '../links/app-links';
import type { EmailSuppressionRepository } from '../suppression/email-suppression.repository';
import { defineTemplate } from '../templates/define-template';
import { removedFromWorkspace } from '../templates/team/removed-from-workspace';
import { EmailTokensService } from '../tokens/email-tokens.service';
import type {
  AnyTemplateDef,
  EmailTemplateDef,
  TemplateGuardDeps,
} from '../templates/types';
import type { DbType } from '../../drizzle/db';
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

const inactiveReminder = register(
  defineTemplate<Props>({
    id: 'inactive-reminder',
    category: 'lifecycle',
    event: 'inactivity_reminder',
    footer: 'plain',
    footerReason: () => 'You signed up.',
    subject: () => 'We miss you',
    preheader: () => 'Come back.',
    Body: (p) => createElement('p', null, p.title),
    fixture: { title: 'T' },
  }),
);

const paymentFailed = register(
  defineTemplate<Props>({
    id: 'payment-failed',
    category: 'billing',
    event: 'billing_alert',
    footer: 'notification',
    subject: () => 'Payment failed',
    preheader: () => 'Update your card.',
    Body: (p) => createElement('p', null, p.title),
    fixture: { title: 'T' },
  }),
);
const planChanged = register(
  defineTemplate<Props>({
    id: 'plan-changed',
    category: 'billing',
    event: 'draft_ready',
    footer: 'notification',
    subject: () => 'Plan changed',
    preheader: () => 'Your plan changed.',
    Body: (p) => createElement('p', null, p.title),
    fixture: { title: 'T' },
  }),
);

const stillApplies = jest.fn<Promise<boolean>, [Props, TemplateGuardDeps]>();
const guardedBody = jest.fn((p: Props) => createElement('p', null, p.title));
const guarded = register(
  defineTemplate<Props>({
    id: 'invitation-accepted',
    category: 'team',
    event: null,
    footer: 'plain',
    footerReason: () => 'Your team changed.',
    subject: () => 'Accepted',
    preheader: () => 'They joined.',
    stillApplies,
    Body: guardedBody,
    fixture: { title: 'T' },
  }),
);
// Lifecycle mail is suppressible, so it shows where the guard runs.
const guardedLifecycle = register(
  defineTemplate<Props>({
    id: 'pausing-soon',
    category: 'lifecycle',
    event: null,
    footer: 'plain',
    footerReason: () => 'You signed up.',
    subject: () => 'Welcome back',
    preheader: () => 'Pick up where you left off.',
    stillApplies,
    Body: guardedBody,
    fixture: { title: 'T' },
  }),
);
// The real B3 def, guard included: the worker side of the removal undo.
register(removedFromWorkspace);

const SECRET = 'outbox-spec-secret';
const USER = '5d0b6f0e-1111-4222-8333-944455556666';
const WS = '11111111-1111-4111-8111-111111111111';
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
  // Only a template's stillApplies guard reads it (B3 reads the member row).
  const db = {
    query: {
      workspaceInvitation: {
        findFirst: jest.fn<
          Promise<{ status: string; removedAt: Date | null } | undefined>,
          [unknown]
        >(() => Promise.resolve(undefined)),
      },
    },
  };
  const tokens = new EmailTokensService(new JwtService({}), {
    get: (k: string) => (k === 'JWT_ACCESS_SECRET' ? SECRET : undefined),
  } as unknown as ConfigService);
  const outbox = new EmailOutboxService(
    queue as unknown as Queue,
    email as unknown as EmailService,
    prefs as unknown as NotificationPreferencesService,
    suppressions as unknown as EmailSuppressionRepository,
    footer as unknown as EmailFooterService,
    links,
    tokens,
    db as unknown as DbType,
  );
  return { outbox, queue, email, prefs, suppressions, footer, tokens, db };
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

  it('resolves true once the job is queued', async () => {
    const { outbox } = make();
    await expect(outbox.enqueue(input)).resolves.toBe(true);
  });

  it('a Redis that never answers: after 5 s resolves "not queued", logs the key, never throws', async () => {
    jest.useFakeTimers();
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const { outbox, queue } = make();
      queue.add.mockReturnValueOnce(new Promise<never>(() => undefined));
      let settled = false;
      const queued = outbox.enqueue(input).finally(() => {
        settled = true;
      });

      await jest.advanceTimersByTimeAsync(4900);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(100);

      await expect(queued).resolves.toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('post-failed.u1.ws1.w1'),
      );
    } finally {
      jest.useRealTimers();
      warn.mockRestore();
    }
  });

  it('a late Redis error after the timeout reaches no one', async () => {
    jest.useFakeTimers();
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const { outbox, queue } = make();
      let fail: (err: Error) => void = () => undefined;
      queue.add.mockReturnValueOnce(
        new Promise<never>((_, reject) => {
          fail = reject;
        }),
      );
      const queued = outbox.enqueue(input);
      await jest.advanceTimersByTimeAsync(5000);
      await expect(queued).resolves.toBe(false);

      fail(new Error('connection lost'));
      // An unhandled rejection would fail the run here.
      await jest.advanceTimersByTimeAsync(0);
    } finally {
      jest.useRealTimers();
      warn.mockRestore();
    }
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
    expect((err as Error).message).toContain('retryable');
  });

  it('the failure reason the worker logs carries the error code, never the provider message', async () => {
    const { outbox, email } = make();
    email.deliver.mockResolvedValueOnce({
      success: false,
      error: 'Invalid `to` field: victim@example.com',
      retryable: false,
      errorCode: 'validation_error',
    });
    const err = await outbox.process(job(postFailed)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toContain('validation_error');
    expect((err as Error).message).not.toContain('@');
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

  it('reports any other failure on a retry as failed, never as already sent', async () => {
    const { outbox, email } = make();
    email.deliver.mockResolvedValueOnce({
      success: false,
      error: 'invalid `to` field',
      retryable: false,
      errorCode: 'validation_error',
    });
    await expect(outbox.process(job(postFailed), 3)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    email.deliver.mockResolvedValueOnce({
      success: false,
      error: 'Too many requests',
      retryable: true,
      errorCode: 'rate_limit_exceeded',
    });
    await expect(outbox.process(job(postFailed), 3)).rejects.toBeInstanceOf(
      RetryableEmailError,
    );
    expect(log).not.toHaveBeenCalledWith(
      expect.stringContaining('already sent by an earlier attempt'),
    );
  });

  it('fails an unknown template without retrying', async () => {
    const { outbox } = make();
    await expect(
      outbox.process({ ...job(postFailed), template: 'nope' as never }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe('EmailOutboxService send-time guard (stillApplies)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    stillApplies.mockReset();
    guardedBody.mockClear();
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('sends when the guard says the mail still applies, and hands it the props and the db', async () => {
    const { outbox, email, db } = make();
    stillApplies.mockResolvedValue(true);
    await expect(outbox.process(job(guarded))).resolves.toBe('sent');
    expect(stillApplies).toHaveBeenCalledWith({ title: 'Launch' }, { db });
    expect(email.deliver).toHaveBeenCalledTimes(1);
  });

  it('skips without rendering when the guard says it no longer applies, and logs the skip', async () => {
    const { outbox, email, footer } = make();
    stillApplies.mockResolvedValue(false);
    await expect(outbox.process(job(guarded))).resolves.toBe('skipped:stale');
    expect(guardedBody).not.toHaveBeenCalled();
    expect(footer.build).not.toHaveBeenCalled();
    expect(email.deliver).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('invitation-accepted.k1'),
    );
  });

  it('fails closed: a guard that throws skips the send and logs a warning', async () => {
    const { outbox, email } = make();
    stillApplies.mockRejectedValue(new Error('db down'));
    await expect(outbox.process(job(guarded))).resolves.toBe('skipped:stale');
    expect(email.deliver).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });

  it('runs after the preference and suppression checks: a suppressed recipient never reaches the guard', async () => {
    const { outbox, suppressions } = make();
    suppressions.isSuppressed.mockResolvedValue(true);
    await expect(outbox.process(job(guardedLifecycle))).resolves.toBe(
      'skipped:suppressed',
    );
    expect(stillApplies).not.toHaveBeenCalled();
  });

  it('sendNow reports a stale send as not sent', async () => {
    const { outbox } = make();
    stillApplies.mockResolvedValue(false);
    await expect(
      outbox.sendNow({ ...input, template: guarded }),
    ).resolves.toEqual({ success: false, error: 'Not sent: skipped:stale' });
  });

  describe('B3 after the undo window', () => {
    const removal = removedFromWorkspace.fixture;
    const b3 = job(removedFromWorkspace, {
      props: removal,
      idempotencyKey: `member-removed.${removal.membershipId}.${removal.removedAtMs}`,
    });

    it('a member still removed gets the email', async () => {
      const { outbox, email, db } = make();
      db.query.workspaceInvitation.findFirst.mockResolvedValue({
        status: 'REMOVED',
        removedAt: new Date(removal.removedAtMs),
      });
      await expect(outbox.process(b3)).resolves.toBe('sent');
      expect(email.deliver).toHaveBeenCalledTimes(1);
      expect(email.deliver.mock.calls[0][0].subject).toBe(
        'You no longer have access to Rehman Workspace',
      );
    });

    it('a member restored inside the window gets nothing', async () => {
      const { outbox, email, db } = make();
      db.query.workspaceInvitation.findFirst.mockResolvedValue({
        status: 'ACCEPTED',
        removedAt: null,
      });
      await expect(outbox.process(b3)).resolves.toBe('skipped:stale');
      expect(email.deliver).not.toHaveBeenCalled();
    });

    it('a member restored then removed again gets nothing for the first removal', async () => {
      const { outbox, email, db } = make();
      db.query.workspaceInvitation.findFirst.mockResolvedValue({
        status: 'REMOVED',
        removedAt: new Date(removal.removedAtMs + 5 * 60_000),
      });
      await expect(outbox.process(b3)).resolves.toBe('skipped:stale');
      expect(email.deliver).not.toHaveBeenCalled();
    });

    it('a DB read that throws skips the send (fail closed) and logs it', async () => {
      const { outbox, email, db } = make();
      db.query.workspaceInvitation.findFirst.mockRejectedValue(
        new Error('connection reset'),
      );
      await expect(outbox.process(b3)).resolves.toBe('skipped:stale');
      expect(email.deliver).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('connection reset'),
      );
    });
  });
});

describe('EmailOutboxService unsubscribe headers', () => {
  const member = { email: 'r@acme.com', userId: USER };

  afterEach(() => jest.useRealTimers());

  /** The headers of the one message delivered. */
  async function headersOf(
    def: AnyTemplateDef,
    extra: Partial<EmailJobData> = {},
  ) {
    const made = make();
    await made.outbox.process(job(def, { to: member, ...extra }));
    return { ...made, headers: made.email.deliver.mock.calls[0][0].headers };
  }

  it('notification mail carries List-Unsubscribe and List-Unsubscribe-Post; security mail carries neither', async () => {
    const { headers, tokens } = await headersOf(postFailed, {
      workspaceId: WS,
    });
    expect(headers?.['List-Unsubscribe-Post']).toBe(
      'List-Unsubscribe=One-Click',
    );
    const link = headers?.['List-Unsubscribe'] ?? '';
    expect(link).toMatch(
      /^<http:\/\/localhost:3000\/email\/unsubscribe\/[\w.-]+>$/,
    );
    const token = link.slice(link.lastIndexOf('/') + 1, -1);
    expect(tokens.verifyUnsubscribe(token)).toEqual({
      uid: USER,
      ws: WS,
      ev: 'post_failed',
    });

    const security = await headersOf(passwordChanged, { workspaceId: null });
    expect(security.headers).toBeUndefined();
    expect(security.email.deliver.mock.calls[0][0]).not.toHaveProperty(
      'headers',
    );
  });

  it('the account-level inactivity reminder carries them with a null workspace', async () => {
    const { headers, tokens } = await headersOf(inactiveReminder, {
      workspaceId: null,
    });
    const link = headers?.['List-Unsubscribe'] ?? '';
    expect(headers?.['List-Unsubscribe-Post']).toBe(
      'List-Unsubscribe=One-Click',
    );
    expect(
      tokens.verifyUnsubscribe(link.slice(link.lastIndexOf('/') + 1, -1)),
    ).toEqual({ uid: USER, ws: null, ev: 'inactivity_reminder' });
  });

  it('List-Unsubscribe is byte-identical on every attempt of the same job', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const { outbox, email } = make();
    const data = job(postFailed, { to: member, workspaceId: WS });
    await outbox.process(data);
    jest.setSystemTime(Date.now() + 5_000);
    await outbox.process(data);
    jest.setSystemTime(Date.now() + 60_000);
    await outbox.process(data);
    const [first, ...rest] = email.deliver.mock.calls.map(
      ([msg]) => msg.headers,
    );
    expect(rest).toHaveLength(2);
    expect(first?.['List-Unsubscribe']).toBeDefined();
    for (const headers of rest) {
      expect(JSON.stringify(headers)).toBe(JSON.stringify(first));
    }
  });

  it('carries none when the event email is locked or the event sends no email', async () => {
    const locked = await headersOf(paymentFailed, { workspaceId: WS });
    expect(locked.headers).toBeUndefined();
    const noEmail = await headersOf(planChanged, { workspaceId: WS });
    expect(noEmail.headers).toBeUndefined();
    expect(noEmail.email.deliver).toHaveBeenCalledTimes(1);
  });

  it('other lifecycle mail carries none, and neither does a recipient who is not a user', async () => {
    const lifecycle = await headersOf(welcome, { workspaceId: null });
    expect(lifecycle.headers).toBeUndefined();
    const guest = await headersOf(postFailed, {
      to: { email: 'guest@acme.com', userId: null },
    });
    expect(guest.headers).toBeUndefined();
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
      errorCode: 'rate_limit_exceeded',
    });
    const res = await outbox.sendNow({ ...input, template: passwordChanged });
    expect(res.success).toBe(false);
    expect(res.error).toContain('rate_limit_exceeded');
    expect(res.error).not.toContain('Too many requests');
    expect(res.retryable).toBe(true);
    // Callers log the code.
    expect(res.errorCode).toBe('rate_limit_exceeded');
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
