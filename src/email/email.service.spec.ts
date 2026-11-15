import { Logger } from '@nestjs/common';
import { EmailService } from './email.service';
import { ConfigService } from '@nestjs/config';

// Every EmailService log line is silenced; the spies let tests read what was logged.
let logSpy: jest.SpyInstance<void, unknown[]>;
let errorSpy: jest.SpyInstance<void, unknown[]>;
beforeEach(() => {
  logSpy = jest
    .spyOn(Logger.prototype, 'log')
    .mockImplementation(() => undefined);
  errorSpy = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
  for (const level of ['warn', 'debug'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterEach(() => jest.restoreAllMocks());

describe('EmailService.deliver attachments and headers', () => {
  function makeSendingService() {
    const config = {
      get: (key: string, def?: string) =>
        key === 'RESEND_API_KEY' ? 're_test_key' : def,
    } as unknown as ConfigService;
    const service = new EmailService(config);
    const send = jest
      .fn<Promise<unknown>, [Record<string, unknown>]>()
      .mockResolvedValue({ data: { id: 'm1' } });
    Object.assign(service, { resend: { emails: { send } } });
    return { service, send };
  }

  const base = { to: 'a@b.co', subject: 'S', html: '<p>h</p>', text: 'h' };
  const opts = {
    idempotencyKey: 'k.1',
    tags: { category: 'lifecycle', template: 'welcome' },
  };

  it('passes attachments and replyTo to Resend', async () => {
    const { service, send } = makeSendingService();
    const attachments = [{ filename: 'r.pdf', content: Buffer.from('%PDF') }];
    const res = await service.deliver(
      { ...base, replyTo: 'owner@acme.com', attachments },
      opts,
    );
    expect(res).toEqual({ success: true, messageId: 'm1' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].attachments).toBe(attachments);
    expect(send.mock.calls[0][0].replyTo).toBe('owner@acme.com');
  });

  it('sends no attachments key without attachments, or with an empty list', async () => {
    const { service, send } = makeSendingService();
    await service.deliver(base, opts);
    await service.deliver({ ...base, attachments: [] }, opts);
    expect(send.mock.calls[0][0]).not.toHaveProperty('attachments');
    expect(send.mock.calls[1][0]).not.toHaveProperty('attachments');
  });

  it('passes headers through to Resend', async () => {
    const { service, send } = makeSendingService();
    const headers = { 'List-Unsubscribe': '<https://api/x>' };
    await service.deliver({ ...base, headers }, opts);
    expect(send.mock.calls[0][0].headers).toEqual(headers);
  });

  it('sends no headers key without headers, or with an empty object', async () => {
    const { service, send } = makeSendingService();
    await service.deliver(base, opts);
    await service.deliver({ ...base, headers: {} }, opts);
    expect(send.mock.calls[0][0]).not.toHaveProperty('headers');
    expect(send.mock.calls[1][0]).not.toHaveProperty('headers');
  });

  it('still reports a failure instead of throwing when Resend rejects', async () => {
    const { service, send } = makeSendingService();
    send.mockRejectedValueOnce(new Error('boom'));
    const res = await service.deliver(
      {
        ...base,
        attachments: [{ filename: 'r.pdf', content: Buffer.from('x') }],
      },
      opts,
    );
    expect(res.success).toBe(false);
  });
});

describe('EmailService.deliver', () => {
  function makeDeliverService(env: Record<string, string> = {}) {
    const values: Record<string, string> = {
      RESEND_API_KEY: 're_test_key',
      ...env,
    };
    const config = {
      get: (key: string, def?: string) => values[key] ?? def,
    } as unknown as ConfigService;
    const service = new EmailService(config);
    const send = jest
      .fn<Promise<unknown>, [Record<string, unknown>, unknown]>()
      .mockResolvedValue({ data: { id: 'm1' }, error: null });
    Object.assign(service, { resend: { emails: { send } } });
    return { service, send };
  }

  const msg = { to: 'a@b.co', subject: 'S', html: '<p>h</p>', text: 'h' };
  const opts = {
    idempotencyKey: 'welcome.u1',
    tags: { category: 'lifecycle', template: 'welcome' },
  };
  const resendError = (name: string, statusCode: number | null) => ({
    data: null,
    error: { name, statusCode, message: `${name} happened` },
  });

  it('deliver passes idempotencyKey and tags', async () => {
    const { service, send } = makeDeliverService();
    const res = await service.deliver(msg, opts);
    expect(res).toEqual({ success: true, messageId: 'm1' });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: [
          { name: 'category', value: 'lifecycle' },
          { name: 'template', value: 'welcome' },
        ],
      }),
      { idempotencyKey: 'welcome.u1' },
    );
  });

  it('sends from RESEND_FROM_EMAIL, defaulting to the Schedura address', async () => {
    const plain = makeDeliverService();
    await plain.service.deliver(msg, opts);
    expect(plain.send.mock.calls[0][0].from).toBe(
      'Schedura <noreply@schedura.ai>',
    );

    const custom = makeDeliverService({
      RESEND_FROM_EMAIL: 'Schedura <notifications@schedura.ai>',
    });
    await custom.service.deliver(msg, opts);
    expect(custom.send.mock.calls[0][0].from).toBe(
      'Schedura <notifications@schedura.ai>',
    );
  });

  it('strips CR/LF from the subject', async () => {
    const { service, send } = makeDeliverService();
    await service.deliver({ ...msg, subject: 'Hi\r\nBcc: x@y.z' }, opts);
    expect(send.mock.calls[0][0].subject).toBe('Hi Bcc: x@y.z');
  });

  it('deliver marks rate_limit_exceeded retryable and validation_error not', async () => {
    const { service, send } = makeDeliverService();
    send.mockResolvedValueOnce(resendError('rate_limit_exceeded', 429));
    send.mockResolvedValueOnce(resendError('validation_error', 422));
    const limited = await service.deliver(msg, opts);
    const invalid = await service.deliver(msg, opts);
    expect(limited).toEqual({
      success: false,
      error: 'rate_limit_exceeded happened',
      retryable: true,
      errorCode: 'rate_limit_exceeded',
    });
    expect(invalid).toEqual({
      success: false,
      error: 'validation_error happened',
      retryable: false,
      errorCode: 'validation_error',
    });
  });

  it.each([
    ['concurrent_idempotent_requests', 409, true],
    ['application_error', 500, true],
    ['internal_server_error', 500, true],
    ['invalid_parameter', 503, true],
    ['application_error', null, true],
    ['daily_quota_exceeded', 429, false],
    ['monthly_quota_exceeded', 429, false],
    ['invalid_from_address', 403, false],
    ['invalid_idempotent_request', 409, false],
  ])('%s with status %s is retryable: %s', async (name, status, retryable) => {
    const { service, send } = makeDeliverService();
    send.mockResolvedValueOnce(resendError(name, status));
    const res = await service.deliver(msg, opts);
    expect(res.success).toBe(false);
    expect(res.retryable).toBe(retryable);
  });

  it('treats a thrown client error as retryable (no answer from Resend)', async () => {
    const { service, send } = makeDeliverService();
    send.mockRejectedValueOnce(new Error('socket hang up'));
    const res = await service.deliver(msg, opts);
    expect(res).toEqual({
      success: false,
      error: 'socket hang up',
      retryable: true,
    });
  });

  it('reports a missing API key as a failure that is not retryable', async () => {
    const config = {
      get: (_key: string, def?: string) => def,
    } as unknown as ConfigService;
    const res = await new EmailService(config).deliver(msg, opts);
    expect(res.success).toBe(false);
    expect(res.retryable).toBe(false);
    expect(res.error).toMatch(/RESEND_API_KEY/);
  });

  it('deliver uses RESEND_REPLY_TO unless the message has replyTo', async () => {
    const withDefault = makeDeliverService({
      RESEND_REPLY_TO: 'help@schedura.ai',
    });
    await withDefault.service.deliver(msg, opts);
    await withDefault.service.deliver(
      { ...msg, replyTo: 'sender@acme.com' },
      opts,
    );
    expect(withDefault.send.mock.calls[0][0].replyTo).toBe('help@schedura.ai');
    expect(withDefault.send.mock.calls[1][0].replyTo).toBe('sender@acme.com');

    const without = makeDeliverService();
    await without.service.deliver(msg, opts);
    expect(without.send.mock.calls[0][0]).not.toHaveProperty('replyTo');
  });

  it('logs a retryable failure at log level only and a final one at error', async () => {
    const { service, send } = makeDeliverService();
    send.mockResolvedValueOnce(resendError('rate_limit_exceeded', 429));
    await service.deliver(msg, opts);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('rate_limit_exceeded'),
    );

    send.mockRejectedValueOnce(new Error('socket hang up'));
    await service.deliver(msg, opts);
    expect(errorSpy).not.toHaveBeenCalled();

    send.mockResolvedValueOnce(resendError('validation_error', 422));
    await service.deliver(msg, opts);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('never logs the address, subject or body', async () => {
    const secret = {
      ...msg,
      subject: 'Your code',
      html: '<p>482910</p>',
      text: '482910',
    };
    const { service, send } = makeDeliverService();
    await service.deliver(secret, opts);
    send.mockResolvedValueOnce(resendError('validation_error', 422));
    await service.deliver(secret, opts);
    const keyless = new EmailService({
      get: (_key: string, def?: string) => def,
    } as unknown as ConfigService);
    await keyless.deliver(secret, opts);

    const lines = [...logSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .map(String)
      .join(' | ');
    expect(lines).toContain('welcome.u1 (welcome)');
    expect(lines).not.toContain('a@b.co');
    expect(lines).not.toContain('Your code');
    expect(lines).not.toContain('482910');
  });
});
