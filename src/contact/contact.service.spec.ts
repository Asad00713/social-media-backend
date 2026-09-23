import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ContactService } from './contact.service';
import { EmailService } from '../email/email.service';
import type { CreateContactDto } from './dto';

function makeDto(overrides: Partial<CreateContactDto> = {}): CreateContactDto {
  return {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    topic: 'billing',
    message: 'I was charged twice for the same period.',
    ...overrides,
  };
}

async function makeService(
  sendEmail = jest.fn().mockResolvedValue({ success: true, messageId: 'm1' }),
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ContactService,
      { provide: EmailService, useValue: { sendEmail } },
      {
        provide: ConfigService,
        useValue: { get: jest.fn((_k: string, d: string) => d) },
      },
    ],
  }).compile();

  return { service: moduleRef.get(ContactService), sendEmail };
}

describe('ContactService', () => {
  it('sends the enquiry to us and an acknowledgement to the sender', async () => {
    const { service, sendEmail } = await makeService();

    const result = await service.submit(makeDto());

    expect(result.delivered).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(2);

    const [enquiry, ack] = sendEmail.mock.calls.map(([arg]) => arg);
    expect(enquiry.to).toBe('info@schedura.ai');
    expect(ack.to).toBe('ada@example.com');
  });

  it('sets reply-to on our copy so a reply reaches the sender', async () => {
    // Without this, replying to the enquiry answers our own Resend address.
    const { service, sendEmail } = await makeService();

    await service.submit(makeDto());

    expect(sendEmail.mock.calls[0][0].replyTo).toBe('ada@example.com');
  });

  it('routes to the configured inbox when one is set', async () => {
    const sendEmail = jest.fn().mockResolvedValue({ success: true });
    const moduleRef = await Test.createTestingModule({
      providers: [
        ContactService,
        { provide: EmailService, useValue: { sendEmail } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('hello@elsewhere.test') },
        },
      ],
    }).compile();

    await moduleRef.get(ContactService).submit(makeDto());

    expect(sendEmail.mock.calls[0][0].to).toBe('hello@elsewhere.test');
  });

  it('reports failure when the enquiry itself cannot be delivered', async () => {
    // The caller turns this into a 503 rather than a success screen: a form
    // that says "thanks" for a message nobody received is worse than an error.
    const sendEmail = jest.fn().mockResolvedValue({
      success: false,
      error: 'RESEND_API_KEY is unset',
    });
    const { service } = await makeService(sendEmail);

    const result = await service.submit(makeDto());

    expect(result.delivered).toBe(false);
    // The acknowledgement is never attempted once the enquiry is lost.
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('still reports success when only the acknowledgement fails', async () => {
    // We hold the enquiry. Failing the request would invite a resend that
    // duplicates something already in our inbox.
    const sendEmail = jest
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'mailbox full' });
    const { service } = await makeService(sendEmail);

    await expect(service.submit(makeDto())).resolves.toEqual({
      delivered: true,
    });
  });

  it('drops honeypot submissions without sending anything', async () => {
    const { service, sendEmail } = await makeService();

    const result = await service.submit(makeDto({ website: 'http://spam.test' }));

    // Reported as delivered so the bot learns nothing from the response.
    expect(result.delivered).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('escapes HTML in sender-supplied text', async () => {
    // The message goes into an HTML email body, so an unescaped payload here
    // would render as markup in our own inbox.
    const { service, sendEmail } = await makeService();

    await service.submit(
      makeDto({
        name: '<script>alert(1)</script>',
        message: 'Look: <img src=x onerror=alert(1)> & co',
      }),
    );

    const { html } = sendEmail.mock.calls[0][0];
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp; co');
  });

  it('includes the company only when one was given', async () => {
    const { service, sendEmail } = await makeService();

    await service.submit(makeDto());
    expect(sendEmail.mock.calls[0][0].text).not.toContain('Company:');

    sendEmail.mockClear();
    await service.submit(makeDto({ company: 'Analytical Engines Ltd' }));
    expect(sendEmail.mock.calls[0][0].text).toContain('Analytical Engines Ltd');
  });

  it('labels the subject line with the topic', async () => {
    const { service, sendEmail } = await makeService();

    await service.submit(makeDto({ topic: 'privacy' }));

    expect(sendEmail.mock.calls[0][0].subject).toBe(
      '[Privacy & data] Ada Lovelace',
    );
  });
});
