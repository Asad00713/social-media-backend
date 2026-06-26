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
