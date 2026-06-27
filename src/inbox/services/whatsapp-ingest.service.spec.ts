import { WhatsAppIngestService } from './whatsapp-ingest.service';

const textPayload = {
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: '1010' },
    contacts: [{ profile: { name: 'Asad' }, wa_id: '15551234567' }],
    messages: [{ from: '15551234567', id: 'wamid.A', timestamp: '1719400000', type: 'text', text: { body: 'hi' } }],
  } }] }],
};

describe('WhatsAppIngestService.ingest', () => {
  it('upserts a DM for a known channel', async () => {
    const inbox = {
      findChannelByPlatformAccount: jest.fn().mockResolvedValue({ id: 7, workspaceId: 'ws' }),
      upsertDm: jest.fn().mockResolvedValue({ id: 'row1' }),
    } as any;
    await new WhatsAppIngestService(inbox).ingest(textPayload);
    expect(inbox.findChannelByPlatformAccount).toHaveBeenCalledWith('whatsapp', '1010');
    expect(inbox.upsertDm).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws',
        channelId: 7,
        platform: 'whatsapp',
        conversationId: '1010:15551234567',
        platformItemId: 'wamid.A',
        text: 'hi',
        fromMe: false,
        authorDisplayName: 'Asad',
        authorPlatformId: '15551234567',
      }),
    );
  });

  it('skips when no channel matches the phone_number_id', async () => {
    const inbox = { findChannelByPlatformAccount: jest.fn().mockResolvedValue(undefined), upsertDm: jest.fn() } as any;
    await new WhatsAppIngestService(inbox).ingest(textPayload);
    expect(inbox.upsertDm).not.toHaveBeenCalled();
  });

  it('skips non-text messages in Phase 1', async () => {
    const inbox = { findChannelByPlatformAccount: jest.fn().mockResolvedValue({ id: 7, workspaceId: 'ws' }), upsertDm: jest.fn() } as any;
    const img = JSON.parse(JSON.stringify(textPayload));
    img.entry[0].changes[0].value.messages[0] = { from: '1', id: 'wamid.I', timestamp: '1719400000', type: 'image', image: { id: 'm' } };
    await new WhatsAppIngestService(inbox).ingest(img);
    expect(inbox.upsertDm).not.toHaveBeenCalled();
  });
});
