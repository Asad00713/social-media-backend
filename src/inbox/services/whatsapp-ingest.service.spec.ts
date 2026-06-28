import { WhatsAppIngestService } from './whatsapp-ingest.service';

const channel = { id: 7, workspaceId: 'ws' };

function makeDeps(over: Partial<Record<string, any>> = {}) {
  const inbox = {
    findChannelByPlatformAccount: jest.fn().mockResolvedValue(channel),
    upsertDm: jest.fn().mockResolvedValue({ id: 'row1' }),
  };
  const channelService = { getAccessToken: jest.fn().mockResolvedValue('tok') };
  const whatsapp = {
    downloadMedia: jest
      .fn()
      .mockResolvedValue({ buffer: Buffer.from([1]), contentType: 'image/jpeg' }),
  };
  const r2 = {
    uploadBuffer: jest
      .fn()
      .mockResolvedValue({ key: 'k', publicUrl: 'https://r2/k.jpg' }),
  };
  return { inbox, channelService, whatsapp, r2, ...over };
}

const wrap = (msg: any) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: '1010' },
    contacts: [{ profile: { name: 'Asad' }, wa_id: '15551234567' }],
    messages: [{ from: '15551234567', id: 'wamid.M', timestamp: '1719400000', ...msg }],
  } }] }],
});

describe('WhatsAppIngestService.ingest', () => {
  it('upserts a text DM with E.164 handle', async () => {
    const d = makeDeps();
    await new WhatsAppIngestService(d.inbox as any, d.channelService as any, d.whatsapp as any, d.r2 as any)
      .ingest(wrap({ type: 'text', text: { body: 'hi' } }));
    expect(d.inbox.upsertDm).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 7, workspaceId: 'ws', platform: 'whatsapp',
        conversationId: '1010:15551234567', text: 'hi', fromMe: false,
        authorHandle: '+15551234567', authorDisplayName: 'Asad',
      }),
    );
  });

  it('downloads media, rehosts to R2, and upserts attachments', async () => {
    const d = makeDeps();
    await new WhatsAppIngestService(d.inbox as any, d.channelService as any, d.whatsapp as any, d.r2 as any)
      .ingest(wrap({ type: 'image', image: { id: 'mid', mime_type: 'image/jpeg', caption: 'look' } }));
    expect(d.whatsapp.downloadMedia).toHaveBeenCalledWith('tok', 'mid');
    expect(d.r2.uploadBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', workspaceId: 'ws', contentType: 'image/jpeg' }),
    );
    expect(d.inbox.upsertDm).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'look',
        attachments: [{ kind: 'image', url: 'https://r2/k.jpg', contentType: 'image/jpeg' }],
      }),
    );
  });

  it('maps a voice note to R2 kind voice', async () => {
    const d = makeDeps();
    d.whatsapp.downloadMedia.mockResolvedValue({ buffer: Buffer.from([1]), contentType: 'audio/ogg' });
    await new WhatsAppIngestService(d.inbox as any, d.channelService as any, d.whatsapp as any, d.r2 as any)
      .ingest(wrap({ type: 'audio', audio: { id: 'a1', mime_type: 'audio/ogg', voice: true } }));
    expect(d.r2.uploadBuffer).toHaveBeenCalledWith(expect.objectContaining({ kind: 'voice' }));
    expect(d.inbox.upsertDm).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [expect.objectContaining({ kind: 'voice' })] }),
    );
  });

  it('falls back to a text note when media rehost fails', async () => {
    const d = makeDeps();
    d.whatsapp.downloadMedia.mockRejectedValue(new Error('boom'));
    await new WhatsAppIngestService(d.inbox as any, d.channelService as any, d.whatsapp as any, d.r2 as any)
      .ingest(wrap({ type: 'image', image: { id: 'mid', mime_type: 'image/jpeg' } }));
    expect(d.inbox.upsertDm).toHaveBeenCalledWith(
      expect.objectContaining({ text: '[media unavailable]' }),
    );
  });

  it('stores a placeholder note for location', async () => {
    const d = makeDeps();
    await new WhatsAppIngestService(d.inbox as any, d.channelService as any, d.whatsapp as any, d.r2 as any)
      .ingest(wrap({ type: 'location', location: { latitude: 1, longitude: 2 } }));
    expect(d.inbox.upsertDm).toHaveBeenCalledWith(expect.objectContaining({ text: '📍 Location' }));
  });

  it('skips when no channel matches', async () => {
    const d = makeDeps({ inbox: { findChannelByPlatformAccount: jest.fn().mockResolvedValue(undefined), upsertDm: jest.fn() } });
    await new WhatsAppIngestService(d.inbox as any, d.channelService as any, d.whatsapp as any, d.r2 as any)
      .ingest(wrap({ type: 'text', text: { body: 'hi' } }));
    expect(d.inbox.upsertDm).not.toHaveBeenCalled();
  });
});
