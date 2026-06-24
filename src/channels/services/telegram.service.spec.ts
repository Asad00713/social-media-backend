import { TelegramService } from './telegram.service';

describe('TelegramService.forToken', () => {
  const svc = new TelegramService({ get: () => '' } as any);

  it('builds an API client bound to the given token', () => {
    const client = svc.forToken('123:ABC');
    expect(client).toBeDefined();
    expect(typeof client.sendMessage).toBe('function');
    expect(typeof client.deleteWebhook).toBe('function');
    expect(typeof client.getWebhookInfo).toBe('function');
  });

  it('getMe POSTs to the token-specific base url', async () => {
    const client = svc.forToken('TOKEN_A');
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: { id: 1, is_bot: true, first_name: 'Bot' },
        }),
        { status: 200 },
      ),
    );
    await client.getMe();
    expect(spy).toHaveBeenCalledWith(
      'https://api.telegram.org/botTOKEN_A/getMe',
      expect.objectContaining({ method: 'POST' }),
    );
    spy.mockRestore();
  });

  it('resolveEntities replaces text_mention with @first_name', () => {
    const client = svc.forToken('T');
    const out = client.resolveEntities('hi bob', [
      {
        type: 'text_mention',
        offset: 3,
        length: 3,
        user: { id: 9, is_bot: false, first_name: 'Bob' },
      } as any,
    ]);
    expect(out).toBe('hi @Bob');
  });
});
