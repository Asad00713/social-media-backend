import { ConfigService } from '@nestjs/config';
import { GoogleOAuthClient } from './google-oauth.client';

describe('GoogleOAuthClient.exchangeForClaims', () => {
  const client = new GoogleOAuthClient({
    get: () => 'x',
  } as unknown as ConfigService);

  afterEach(() => jest.restoreAllMocks());

  it('bounds the token request with an abort signal', async () => {
    const spy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: false, status: 500 } as Response);
    await expect(client.exchangeForClaims('c', 'v')).rejects.toThrow();
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws on a non-ok response', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: false, status: 400 } as Response);
    await expect(client.exchangeForClaims('c', 'v')).rejects.toThrow(
      'Google token endpoint answered 400',
    );
  });
});
