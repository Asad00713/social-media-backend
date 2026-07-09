import { WhatsAppService, GRAPH_API_VERSION } from './whatsapp.service';

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

describe('WhatsAppService.downloadMedia', () => {
  const svc = new WhatsAppService();
  afterEach(() => jest.restoreAllMocks());

  it('resolves the media url then downloads the binary with the bearer', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch' as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: 'https://lookaside.fbsbx.com/x', mime_type: 'image/jpeg' }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as any);

    const out = await svc.downloadMedia('tok', 'media123');

    expect(out.contentType).toBe('image/jpeg');
    expect(Buffer.isBuffer(out.buffer)).toBe(true);
    expect(out.buffer.length).toBe(3);
    expect(fetchMock.mock.calls[0][0]).toBe('https://graph.facebook.com/v21.0/media123');
    expect((fetchMock.mock.calls[0][1] as any).headers.Authorization).toBe('Bearer tok');
    expect(fetchMock.mock.calls[1][0]).toBe('https://lookaside.fbsbx.com/x');
    expect((fetchMock.mock.calls[1][1] as any).headers.Authorization).toBe('Bearer tok');
  });

  it('throws when the media lookup fails', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { message: 'media not found' } }),
    } as any);
    await expect(svc.downloadMedia('tok', 'bad')).rejects.toThrow('media not found');
  });
});

describe('WhatsAppService.sendMedia', () => {
  const svc = new WhatsAppService();
  afterEach(() => jest.restoreAllMocks());

  it('sends an image with a caption', async () => {
    const fetchMock = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.IMG' }] }),
    } as any);

    const res = await svc.sendMedia('tok', '1010', '15551234567', {
      type: 'image',
      link: 'https://r2.example/x.jpg',
      caption: 'here you go',
    });

    expect(res).toEqual({ messageId: 'wamid.IMG' });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as any).body)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'image',
      image: { link: 'https://r2.example/x.jpg', caption: 'here you go' },
    });
  });

  it('omits caption for audio', async () => {
    const fetchMock = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.AUD' }] }),
    } as any);

    await svc.sendMedia('tok', '1010', '15551234567', {
      type: 'audio',
      link: 'https://r2.example/v.ogg',
      caption: 'ignored',
    });

    expect(JSON.parse((fetchMock.mock.calls[0][1] as any).body)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'audio',
      audio: { link: 'https://r2.example/v.ogg' },
    });
  });
});

describe('WhatsAppService.subscribeWaba', () => {
  const svc = new WhatsAppService();
  afterEach(() => jest.restoreAllMocks());

  it('POSTs to the WABA subscribed_apps edge', async () => {
    const fetchMock = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as any);
    await svc.subscribeWaba('tok', '12345');
    expect(fetchMock.mock.calls[0][0]).toBe('https://graph.facebook.com/v21.0/12345/subscribed_apps');
    expect((fetchMock.mock.calls[0][1] as any).method).toBe('POST');
    expect((fetchMock.mock.calls[0][1] as any).headers.Authorization).toBe('Bearer tok');
  });

  it('throws on API failure', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: false, status: 400, json: async () => ({ error: { message: 'no perms' } }),
    } as any);
    await expect(svc.subscribeWaba('tok', '12345')).rejects.toThrow('no perms');
  });
});

describe('WhatsAppService — Embedded Signup Graph methods', () => {
  let service: WhatsAppService;
  const OLD_ENV = process.env;

  beforeEach(() => {
    service = new WhatsAppService();
    process.env = { ...OLD_ENV, META_APP_ID: 'app123', META_APP_SECRET: 'secret456' };
    global.fetch = jest.fn();
  });
  afterEach(() => {
    process.env = OLD_ENV;
    jest.resetAllMocks();
  });

  it('pins Graph API version to v21.0', () => {
    expect(GRAPH_API_VERSION).toBe('v21.0');
  });

  it('exchangeCodeForBusinessToken hits oauth/access_token with app creds + code', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'biz-token', expires_in: 5184000 }),
    });
    const res = await service.exchangeCodeForBusinessToken('the-code');
    expect(res).toEqual({ accessToken: 'biz-token', expiresIn: 5184000 });
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain(`/${GRAPH_API_VERSION}/oauth/access_token`);
    expect(url).toContain('client_id=app123');
    expect(url).toContain('client_secret=secret456');
    expect(url).toContain('code=the-code');
  });

  it('exchangeCodeForBusinessToken returns null expiresIn when Meta omits it (never-expiring config)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'biz-token' }),
    });
    const res = await service.exchangeCodeForBusinessToken('c');
    expect(res).toEqual({ accessToken: 'biz-token', expiresIn: null });
  });

  it('exchangeCodeForBusinessToken throws the Meta error message on failure', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Invalid code' } }),
    });
    await expect(service.exchangeCodeForBusinessToken('bad')).rejects.toThrow('Invalid code');
  });

  it('registerPhoneNumber posts messaging_product + pin', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    await service.registerPhoneNumber('tok', '111', '123456');
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}/111/register`);
    expect(JSON.parse((init as any).body)).toEqual({ messaging_product: 'whatsapp', pin: '123456' });
  });

  it('registerPhoneNumber treats "already registered" as success', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Phone number already registered', code: 100 } }),
    });
    await expect(service.registerPhoneNumber('tok', '111', '123456')).resolves.toBeUndefined();
  });

  it('registerPhoneNumber throws on a genuine failure', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Two-step verification pin mismatch' } }),
    });
    await expect(service.registerPhoneNumber('tok', '111', '000000')).rejects.toThrow(
      'Two-step verification pin mismatch',
    );
  });

  it('getWabaPhoneNumbers maps the Graph response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: '111', display_phone_number: '+1 555', verified_name: 'Acme' },
          { id: '222', display_phone_number: null, verified_name: null },
        ],
      }),
    });
    const res = await service.getWabaPhoneNumbers('tok', 'waba1');
    expect(res).toEqual([
      { id: '111', displayPhoneNumber: '+1 555', verifiedName: 'Acme' },
      { id: '222', displayPhoneNumber: null, verifiedName: null },
    ]);
  });
});
