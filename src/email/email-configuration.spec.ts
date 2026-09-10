import { EmailService } from './email.service';

/**
 * A missing API key must be reported as a failure.
 *
 * It used to be reported as a success: the no-key branch logged the message
 * and returned `{ success: true }`, so no caller could distinguish "delivered"
 * from "silently discarded". A production deployment without RESEND_API_KEY
 * told every new user to check an inbox that would never receive anything, and
 * nothing in the system disagreed.
 */
describe('EmailService without an API key', () => {
  const config = { get: jest.fn(() => undefined) };
  const service = new EmailService(config as never);

  it('reports failure rather than a phantom success', async () => {
    const result = await service.sendEmail({
      to: 'someone@example.com',
      subject: 'Verify your email',
      html: '<p>123456</p>',
    });

    expect(result.success).toBe(false);
    // The reason has to name the missing configuration — an operator reading
    // this in a log needs to know which variable to set.
    expect(result.error).toMatch(/RESEND_API_KEY/);
  });

  it('reports itself as unconfigured', () => {
    expect(service.isConfigured()).toBe(false);
  });
});
