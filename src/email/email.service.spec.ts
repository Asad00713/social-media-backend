import { EmailService } from './email.service';
import { ConfigService } from '@nestjs/config';

function makeService(): EmailService {
  // No RESEND_API_KEY → sendEmail logs instead of sending, and now reports
  // failure. This test is about how the accept URL is BUILT, which happens
  // before delivery is attempted and is unaffected either way.
  const config = {
    get: (key: string, def?: string) =>
      key === 'FRONTEND_URL' ? 'https://app.schedura.ai' : def,
  } as unknown as ConfigService;
  return new EmailService(config);
}

describe('EmailService.sendWorkspaceInvitation', () => {
  it('builds the accept URL from FRONTEND_URL and sends', async () => {
    const service = makeService();
    const spy = jest.spyOn(service, 'sendEmail');
    const res = await service.sendWorkspaceInvitation('teammate@acme.com', {
      workspaceName: 'Acme',
      inviterName: 'Sam',
      role: 'MEMBER',
      token: 'tok123',
      expiresAt: new Date('2026-08-02T00:00:00Z'),
    });
    // Not delivered: there is no API key in this fixture. That is no longer
    // reported as a success — a missing key used to return success: true,
    // which is precisely the bug that let unsent verification emails pass for
    // sent ones. What matters here is the payload handed to sendEmail.
    expect(res.success).toBe(false);
    const arg = spy.mock.calls[0][0];
    expect(arg.to).toBe('teammate@acme.com');
    expect(arg.html).toContain('https://app.schedura.ai/invite/accept?token=tok123');
    expect(arg.text).toContain('https://app.schedura.ai/invite/accept?token=tok123');
    expect(arg.subject).toContain('Acme');
  });
});

describe('EmailService.sendEmail attachments and headers', () => {
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

  it('passes attachments and replyTo to Resend', async () => {
    const { service, send } = makeSendingService();
    const attachments = [{ filename: 'r.pdf', content: Buffer.from('%PDF') }];
    const res = await service.sendEmail({
      ...base,
      replyTo: 'owner@acme.com',
      attachments,
    });
    expect(res).toEqual({ success: true, messageId: 'm1' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].attachments).toBe(attachments);
    expect(send.mock.calls[0][0].replyTo).toBe('owner@acme.com');
  });

  it('sends no attachments key without attachments, or with an empty list', async () => {
    const { service, send } = makeSendingService();
    await service.sendEmail(base);
    await service.sendEmail({ ...base, attachments: [] });
    expect(send.mock.calls[0][0]).not.toHaveProperty('attachments');
    expect(send.mock.calls[1][0]).not.toHaveProperty('attachments');
  });

  it('passes headers through to Resend', async () => {
    const { service, send } = makeSendingService();
    const headers = { 'List-Unsubscribe': '<https://api/x>' };
    await service.sendEmail({ ...base, headers });
    expect(send.mock.calls[0][0].headers).toEqual(headers);
  });

  it('sends no headers key without headers, or with an empty object', async () => {
    const { service, send } = makeSendingService();
    await service.sendEmail(base);
    await service.sendEmail({ ...base, headers: {} });
    expect(send.mock.calls[0][0]).not.toHaveProperty('headers');
    expect(send.mock.calls[1][0]).not.toHaveProperty('headers');
  });

  it('still reports a failure instead of throwing when Resend rejects', async () => {
    const { service, send } = makeSendingService();
    send.mockRejectedValueOnce(new Error('boom'));
    const res = await service.sendEmail({
      ...base,
      attachments: [{ filename: 'r.pdf', content: Buffer.from('x') }],
    });
    expect(res.success).toBe(false);
  });
});

describe('EmailService.sendChannelConnectLink', () => {
  it('states the expiry as a UTC date, labelled UTC, whatever the server time zone', async () => {
    const service = makeService();
    const spy = jest.spyOn(service, 'sendEmail');
    // 23:30 UTC on Nov 20: already Nov 21 east of UTC, still Nov 20 in UTC
    await service.sendChannelConnectLink('client@example.com', {
      workspaceName: 'Acme',
      senderName: 'Sam',
      networks: ['instagram'],
      url: 'https://app.schedura.ai/c/tok',
      expiresAt: new Date('2026-11-20T23:30:00Z'),
    });
    const arg = spy.mock.calls[0][0];
    expect(arg.text).toContain('works until November 20, 2026 (UTC)');
    expect(arg.html).toContain('November 20, 2026 (UTC)');
  });
});
