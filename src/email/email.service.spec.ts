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
