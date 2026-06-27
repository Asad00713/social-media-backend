import { WhatsAppDmAdapter } from './whatsapp-dm.adapter';
import type { ResolvedChannel } from './inbox-adapter.interface';

const channel = (): ResolvedChannel => ({
  id: 1,
  workspaceId: 'ws',
  platform: 'whatsapp',
  platformAccountId: '1010',
  accessToken: 'tok',
  metadata: { phoneNumberId: '1010' },
  username: null,
  accountName: 'My Biz',
  profilePictureUrl: null,
});

describe('WhatsAppDmAdapter', () => {
  it('sends to the wa_id parsed from conversationId', async () => {
    const wa = { sendText: jest.fn().mockResolvedValue({ messageId: 'wamid.X' }) } as any;
    const adapter = new WhatsAppDmAdapter(wa);
    const res = await adapter.sendDm(channel(), '1010:15551234567', 'hello');
    expect(wa.sendText).toHaveBeenCalledWith('tok', '1010', '15551234567', 'hello');
    expect(res.conversationId).toBe('1010:15551234567');
    expect(res.platformItemId).toBe('wamid.X');
  });

  it('reports the 24h window closed when last inbound > 24h ago', async () => {
    const adapter = new WhatsAppDmAdapter({} as any);
    const old = new Date(Date.now() - 25 * 3600 * 1000);
    const state = await adapter.getReplyWindowState(channel(), '1010:999', old);
    expect(state.canReply).toBe(false);
  });

  it('reports the window open within 24h', async () => {
    const adapter = new WhatsAppDmAdapter({} as any);
    const recent = new Date(Date.now() - 1000);
    const state = await adapter.getReplyWindowState(channel(), '1010:999', recent);
    expect(state.canReply).toBe(true);
  });

  it('has no readable history (push-only)', async () => {
    const adapter = new WhatsAppDmAdapter({} as any);
    expect(await adapter.listConversations(channel())).toEqual([]);
    expect(await adapter.fetchConversationMessages(channel(), '1010:999')).toEqual([]);
  });
});

describe('WhatsAppDmAdapter.sendDmWithAttachments', () => {
  it('sends an image carrying the text as caption', async () => {
    const wa = { sendMedia: jest.fn().mockResolvedValue({ messageId: 'wamid.IMG' }), sendText: jest.fn() } as any;
    const adapter = new WhatsAppDmAdapter(wa);
    const res = await adapter.sendDmWithAttachments(channel(), '1010:15551234567', 'caption!', [
      { kind: 'image', url: 'https://r2/x.jpg', contentType: 'image/jpeg' },
    ]);
    expect(wa.sendMedia).toHaveBeenCalledWith('tok', '1010', '15551234567', {
      type: 'image', link: 'https://r2/x.jpg', caption: 'caption!', filename: undefined,
    });
    expect(wa.sendText).not.toHaveBeenCalled();
    expect(res.platformItemId).toBe('wamid.IMG');
  });

  it('sends a voice note then the text as a separate message (audio has no caption)', async () => {
    const wa = {
      sendMedia: jest.fn().mockResolvedValue({ messageId: 'wamid.AUD' }),
      sendText: jest.fn().mockResolvedValue({ messageId: 'wamid.TXT' }),
    } as any;
    const adapter = new WhatsAppDmAdapter(wa);
    const res = await adapter.sendDmWithAttachments(channel(), '1010:15551234567', 'hello', [
      { kind: 'voice', url: 'https://r2/v.ogg', contentType: 'audio/ogg' },
    ]);
    expect(wa.sendMedia).toHaveBeenCalledWith('tok', '1010', '15551234567', {
      type: 'audio', link: 'https://r2/v.ogg', caption: undefined, filename: undefined,
    });
    expect(wa.sendText).toHaveBeenCalledWith('tok', '1010', '15551234567', 'hello');
    expect(res.platformItemId).toBe('wamid.TXT');
  });

  it('falls back to sendDm when there are no attachments', async () => {
    const wa = { sendText: jest.fn().mockResolvedValue({ messageId: 'wamid.X' }), sendMedia: jest.fn() } as any;
    const adapter = new WhatsAppDmAdapter(wa);
    await adapter.sendDmWithAttachments(channel(), '1010:999', 'hi', []);
    expect(wa.sendText).toHaveBeenCalled();
    expect(wa.sendMedia).not.toHaveBeenCalled();
  });
});
