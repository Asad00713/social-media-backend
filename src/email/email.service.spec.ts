import { EmailService } from './email.service';
import { ConfigService } from '@nestjs/config';

function makeService(): EmailService {
  // No RESEND_API_KEY → sendEmail logs instead of sending, returns success.
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
    expect(res.success).toBe(true);
    const arg = spy.mock.calls[0][0];
    expect(arg.to).toBe('teammate@acme.com');
    expect(arg.html).toContain('https://app.schedura.ai/invite/accept?token=tok123');
    expect(arg.text).toContain('https://app.schedura.ai/invite/accept?token=tok123');
    expect(arg.subject).toContain('Acme');
  });
});
