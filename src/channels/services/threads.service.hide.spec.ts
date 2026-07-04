import { BadRequestException } from '@nestjs/common';
import { ThreadsService } from './threads.service';

describe('ThreadsService.manageReply', () => {
  const svc = new ThreadsService();
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('POSTs hide flag to manage_reply', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    global.fetch = jest.fn(async (url: string, init: any) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ success: true }) };
    }) as unknown as typeof fetch;

    await svc.manageReply('tok', 'reply99', true);
    expect(capturedUrl).toContain('/reply99/manage_reply');
    expect(capturedBody).toEqual({ access_token: 'tok', hide: true });
  });

  it('throws BadRequest on API error', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      json: async () => ({ error: { message: 'nope' } }),
    })) as unknown as typeof fetch;
    await expect(svc.manageReply('tok', 'r', false)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
