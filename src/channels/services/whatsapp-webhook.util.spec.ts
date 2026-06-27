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

describe('parseWhatsAppMessages — media', () => {
  const wrap = (msg: any) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '1010' },
      contacts: [{ profile: { name: 'Asad' }, wa_id: '15551234567' }],
      messages: [{ from: '15551234567', id: 'wamid.M', timestamp: '1719400000', ...msg }],
    } }] }],
  });

  it('captures an image with caption', () => {
    const [m] = parseWhatsAppMessages(wrap({ type: 'image', image: { id: 'mid', mime_type: 'image/jpeg', caption: 'look' } }));
    expect(m.isText).toBe(false);
    expect(m.media).toEqual({ mediaId: 'mid', kind: 'image', mimeType: 'image/jpeg', caption: 'look', filename: undefined });
    expect(m.text).toBe('look');
  });

  it('maps a voice note (audio.voice=true) to kind voice', () => {
    const [m] = parseWhatsAppMessages(wrap({ type: 'audio', audio: { id: 'a1', mime_type: 'audio/ogg', voice: true } }));
    expect(m.media?.kind).toBe('voice');
  });

  it('maps non-voice audio to kind audio', () => {
    const [m] = parseWhatsAppMessages(wrap({ type: 'audio', audio: { id: 'a2', mime_type: 'audio/mpeg' } }));
    expect(m.media?.kind).toBe('audio');
  });

  it('maps a document to kind file with filename', () => {
    const [m] = parseWhatsAppMessages(wrap({ type: 'document', document: { id: 'd1', mime_type: 'application/pdf', filename: 'invoice.pdf', caption: 'bill' } }));
    expect(m.media).toEqual({ mediaId: 'd1', kind: 'file', mimeType: 'application/pdf', caption: 'bill', filename: 'invoice.pdf' });
  });

  it('maps a sticker to kind image', () => {
    const [m] = parseWhatsAppMessages(wrap({ type: 'sticker', sticker: { id: 's1', mime_type: 'image/webp' } }));
    expect(m.media?.kind).toBe('image');
  });

  it('captures a video', () => {
    const [m] = parseWhatsAppMessages(wrap({ type: 'video', video: { id: 'v1', mime_type: 'video/mp4' } }));
    expect(m.media?.kind).toBe('video');
  });

  it('emits a note for location and contacts', () => {
    const [loc] = parseWhatsAppMessages(wrap({ type: 'location', location: { latitude: 1, longitude: 2 } }));
    expect(loc.note).toBe('📍 Location');
    const [con] = parseWhatsAppMessages(wrap({ type: 'contacts', contacts: [{ name: { formatted_name: 'X' } }] }));
    expect(con.note).toBe('👤 Contact');
  });

  it('skips unsupported types (e.g. reaction)', () => {
    expect(parseWhatsAppMessages(wrap({ type: 'reaction', reaction: { emoji: '👍' } }))).toEqual([]);
  });
});
