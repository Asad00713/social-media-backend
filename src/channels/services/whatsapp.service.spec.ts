import { WhatsAppService } from './whatsapp.service';

describe('WhatsAppService.sendText', () => {
  const svc = new WhatsAppService();
  afterEach(() => jest.restoreAllMocks());

  it('POSTs a text message and returns the message id', async () => {
    const fetchMock = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.ABC' }] }),
    } as any);

    const res = await svc.sendText('tok', '1010', '15551234567', 'hi');

    expect(res).toEqual({ messageId: 'wamid.ABC' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v21.0/1010/messages');
    expect((init as any).method).toBe('POST');
    expect(JSON.parse((init as any).body)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'text',
      text: { body: 'hi', preview_url: false },
    });
    expect((init as any).headers.Authorization).toBe('Bearer tok');
  });

  it('throws with the Graph error message on failure', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Recipient not in allowed list' } }),
    } as any);
    await expect(svc.sendText('tok', '1010', '999', 'hi')).rejects.toThrow(
      'Recipient not in allowed list',
    );
  });
});
