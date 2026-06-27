import { parseWhatsAppMessages } from './whatsapp-webhook.util';

const payload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA_ID',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550000000', phone_number_id: '1010' },
            contacts: [{ profile: { name: 'Asad' }, wa_id: '15551234567' }],
            messages: [
              {
                from: '15551234567',
                id: 'wamid.HBgL',
                timestamp: '1719400000',
                type: 'text',
                text: { body: 'Hi, is this available?' },
                referral: { source_type: 'ad', source_id: 'AD123' },
              },
            ],
          },
        },
      ],
    },
  ],
};

describe('parseWhatsAppMessages', () => {
  it('extracts a text message with author + ad referral', () => {
    const [m] = parseWhatsAppMessages(payload);
    expect(m.phoneNumberId).toBe('1010');
    expect(m.fromWaId).toBe('15551234567');
    expect(m.messageId).toBe('wamid.HBgL');
    expect(m.text).toBe('Hi, is this available?');
    expect(m.authorName).toBe('Asad');
    expect(m.isText).toBe(true);
    expect(m.timestamp.getTime()).toBe(1719400000 * 1000);
    expect(m.referral?.source_id).toBe('AD123');
  });

  it('marks non-text (e.g. image) as isText=false', () => {
    const img = JSON.parse(JSON.stringify(payload));
    img.entry[0].changes[0].value.messages[0] = {
      from: '15551234567', id: 'wamid.IMG', timestamp: '1719400001', type: 'image',
      image: { id: 'media123' },
    };
    const [m] = parseWhatsAppMessages(img);
    expect(m.isText).toBe(false);
    expect(m.text).toBe('');
  });

  it('returns [] for status-only callbacks (delivery/read receipts)', () => {
    const status = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'X', changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: '1010' },
        statuses: [{ id: 'wamid.X', status: 'delivered' }],
      } }] }],
    };
    expect(parseWhatsAppMessages(status)).toEqual([]);
  });
});
