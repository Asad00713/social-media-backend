import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AppLinks } from '../email/links/app-links';
import type { EmailOutboxService } from '../email/queue/email-outbox.service';
import { renderEmail } from '../email/render/render-email';
import type { AnyTemplateDef } from '../email/templates/types';
import type { ContactAckLimiter } from './contact-ack-limiter';
import { ContactService } from './contact.service';
import type { CreateContactDto } from './dto';

const CTX = {
  assetBaseUrl: 'https://app.test/email',
  footer: { reason: 'Why line', links: [] },
};

const REFERENCE_RE = 'SCH-[0-9A-HJKMNP-TV-Z]{6}';

function makeDto(overrides: Partial<CreateContactDto> = {}): CreateContactDto {
  return {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    topic: 'billing',
    message: 'I was charged twice for the same period.',
    ...overrides,
  };
}

interface Sent {
  template: AnyTemplateDef;
  props: unknown;
  to: { email: string; userId: string | null };
  idempotencyKey: string;
  replyTo?: string;
}

interface Doubles {
  sendNow?: jest.Mock;
  enqueue?: jest.Mock;
  allow?: jest.Mock;
}

function makeService(
  env: Record<string, string> = { CONTACT_INBOX_EMAIL: 'inbox@us.test' },
  doubles: Doubles = {},
) {
  const sendNow =
    doubles.sendNow ?? jest.fn().mockResolvedValue({ success: true });
  const enqueue = doubles.enqueue ?? jest.fn().mockResolvedValue(undefined);
  const allow = doubles.allow ?? jest.fn().mockResolvedValue(true);
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  const service = new ContactService(
    { sendNow, enqueue } as unknown as EmailOutboxService,
    new AppLinks(config),
    { allow } as unknown as ContactAckLimiter,
    config,
  );
  return { service, sendNow, enqueue, allow };
}

const sentOf = (mock: jest.Mock): Sent => (mock.mock.calls as Sent[][])[0][0];

function render(sent: Sent) {
  return renderEmail(sent.template, sent.props, CTX);
}

describe('ContactService', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    const capture = (message: unknown) => {
      logged.push(String(message));
    };
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(capture);
  });

  afterEach(() => jest.restoreAllMocks());

  it('sends the enquiry to the inbox inline, replying to the sender', async () => {
    const { service, sendNow, enqueue } = makeService();

    const result = await service.submit(makeDto());

    expect(result).toEqual({ delivered: true });
    expect(sendNow).toHaveBeenCalledTimes(1);
    const enquiry = sentOf(sendNow);
    expect(enquiry.template.id).toBe('contact-enquiry');
    expect(enquiry.to).toEqual({ email: 'inbox@us.test', userId: null });
    expect(enquiry.replyTo).toBe('ada@example.com');
    expect(enquiry.idempotencyKey).toMatch(
      new RegExp(`^contact\\.${REFERENCE_RE}$`),
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('queues the acknowledgement for the sender, replying to the inbox', async () => {
    const { service, sendNow, enqueue } = makeService();

    await service.submit(makeDto());

    const ack = sentOf(enqueue);
    expect(ack.template.id).toBe('contact-received');
    expect(ack.to).toEqual({ email: 'ada@example.com', userId: null });
    expect(ack.replyTo).toBe('inbox@us.test');
    // One reference ties the two mails together.
    const { reference } = ack.props as { reference: string };
    expect(reference).toMatch(new RegExp(`^${REFERENCE_RE}$`));
    expect(ack.idempotencyKey).toBe(`contact-ack.${reference}`);
    expect(sentOf(sendNow).idempotencyKey).toBe(`contact.${reference}`);
    expect(ack.props).toMatchObject({
      topic: 'Billing & refunds',
      message: 'I was charged twice for the same period.',
      maestroUrl: 'http://localhost:3001/',
    });
  });

  it('puts the topic and reference in the enquiry subject', async () => {
    const { service, sendNow } = makeService();

    await service.submit(makeDto({ topic: 'privacy' }));

    const enquiry = sentOf(sendNow);
    const { reference } = enquiry.props as { reference: string };
    expect((await render(enquiry)).subject).toBe(
      `[Privacy & data] Ada Lovelace · #${reference}`,
    );
  });

  it('reports failure and queues no acknowledgement when the enquiry cannot be sent', async () => {
    // The caller turns this into a 503 rather than a success screen.
    const { service, enqueue } = makeService(undefined, {
      sendNow: jest.fn().mockResolvedValue({
        success: false,
        error: 'RESEND_API_KEY is unset',
      }),
    });

    const result = await service.submit(makeDto());

    expect(result).toEqual({ delivered: false });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('still reports success when the acknowledgement cannot be queued', async () => {
    // We hold the enquiry. Failing the request would invite a resend.
    const { service } = makeService(undefined, {
      enqueue: jest.fn().mockRejectedValue(new Error('Redis is down')),
    });

    await expect(service.submit(makeDto())).resolves.toEqual({
      delivered: true,
    });
  });

  it('drops honeypot submissions without sending anything', async () => {
    const { service, sendNow, enqueue } = makeService();

    const result = await service.submit(
      makeDto({ website: 'http://spam.test' }),
    );

    // Reported as delivered so the bot learns nothing from the response.
    expect(result.delivered).toBe(true);
    expect(sendNow).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('escapes markup in sender-supplied text in both emails', async () => {
    const { service, sendNow, enqueue } = makeService();

    await service.submit(
      makeDto({
        name: '<script>alert(1)</script>',
        company: '<i>Acme</i>',
        message: '<b>hi</b> & <img src=x onerror=alert(1)>',
      }),
    );

    const enquiry = await render(sentOf(sendNow));
    const ack = await render(sentOf(enqueue));
    for (const { html } of [enquiry, ack]) {
      expect(html).not.toContain('<b>hi</b>');
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;b&gt;hi&lt;/b&gt; &amp; &lt;img');
    }
    expect(enquiry.html).not.toContain('<script>');
    expect(enquiry.html).toContain('&lt;script&gt;');
    expect(enquiry.html).toContain('&lt;i&gt;Acme&lt;/i&gt;');
  });

  it('keeps CR and LF in a name out of the subject', async () => {
    const { service, sendNow } = makeService();

    await service.submit(
      makeDto({ name: 'Ada\r\nBcc: victim@evil.test\nSubject: pwned' }),
    );

    expect((await render(sentOf(sendNow))).subject).not.toMatch(/[\r\n]/);
  });

  it('omits Reply-To when the sender address could break a header', async () => {
    const { service, sendNow } = makeService();

    await service.submit(
      makeDto({ email: 'ada@example.com\r\nBcc: victim@evil.test' }),
    );

    expect(sentOf(sendNow).replyTo).toBeUndefined();
  });

  it('caps a long name in the subject', async () => {
    const { service, sendNow } = makeService();

    await service.submit(makeDto({ name: 'A'.repeat(120) }));

    const { subject } = await render(sentOf(sendNow));
    expect(subject).toContain(`[Billing & refunds] ${'A'.repeat(80)} · #`);
    expect(subject).not.toContain('A'.repeat(81));
  });

  it('queues only the first 1 000 characters of the message for the acknowledgement', async () => {
    const { service, sendNow, enqueue } = makeService();
    const message = 'x'.repeat(4000);

    await service.submit(makeDto({ message }));

    const queued = (sentOf(enqueue).props as { message: string }).message;
    expect(queued).toHaveLength(1000);
    // Our own copy keeps all of it.
    expect((sentOf(sendNow).props as { message: string }).message).toBe(
      message,
    );
  });

  it('falls back to SUPPORT_EMAIL when no contact inbox is set', async () => {
    const { service, sendNow } = makeService({ SUPPORT_EMAIL: 'help@us.test' });

    await service.submit(makeDto());

    expect(sentOf(sendNow).to.email).toBe('help@us.test');
  });

  it('logs by reference and sends nothing when there is no address to send to', async () => {
    // AppLinks defaults a blank SUPPORT_EMAIL, so blank the resolved address.
    jest.spyOn(AppLinks.prototype, 'supportEmail').mockReturnValue('');
    const { service, sendNow, enqueue } = makeService({});

    const result = await service.submit(makeDto());

    expect(result).toEqual({ delivered: false });
    expect(sendNow).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(logged.join('\n')).toMatch(new RegExp(`#${REFERENCE_RE}`));
  });

  it('skips only the acknowledgement when the recipient is over their cap', async () => {
    const { service, sendNow, enqueue, allow } = makeService(undefined, {
      allow: jest.fn().mockResolvedValue(false),
    });

    const result = await service.submit(makeDto());

    // The enquiry still reaches support and the sender sees success.
    expect(result).toEqual({ delivered: true });
    expect(sendNow).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(allow).toHaveBeenCalledWith('ada@example.com');
    const { reference } = sentOf(sendNow).props as { reference: string };
    expect(logged.join('\n')).toContain(`#${reference}`);
    expect(logged.join('\n')).not.toContain('ada@example.com');
  });

  it('does not count a recipient for a honeypot hit or a lost enquiry', async () => {
    const spam = makeService();
    await spam.service.submit(makeDto({ website: 'spam' }));
    const lost = makeService(undefined, {
      sendNow: jest.fn().mockResolvedValue({ success: false, error: 'boom' }),
    });
    await lost.service.submit(makeDto());

    expect(spam.allow).not.toHaveBeenCalled();
    expect(lost.allow).not.toHaveBeenCalled();
  });

  it('never logs the sender address or the message', async () => {
    await makeService(undefined, {
      sendNow: jest.fn().mockResolvedValue({ success: false, error: 'boom' }),
    }).service.submit(makeDto());
    await makeService(undefined, {
      enqueue: jest.fn().mockRejectedValue(new Error('Redis is down')),
    }).service.submit(makeDto());
    await makeService().service.submit(makeDto({ website: 'spam' }));

    expect(logged).toHaveLength(3);
    const all = logged.join('\n');
    expect(all).not.toContain('ada@example.com');
    expect(all).not.toContain('charged twice');
  });
});
