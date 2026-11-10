import type { Request, Response } from 'express';
import {
  NOT_FOUND_TEXT,
  ShortLinkRedirectController,
} from './short-link-redirect.controller';
import type { ShortLinksService } from './short-links.service';

function fakeRes() {
  const res = {
    headers: {} as Record<string, string>,
    statusCode: 200,
    body: undefined as unknown,
    location: undefined as string | undefined,
    contentType: undefined as string | undefined,
    setHeader(k: string, v: string) {
      res.headers[k] = v;
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    type(t: string) {
      res.contentType = t;
      return res;
    },
    send(b: unknown) {
      res.body = b;
      return res;
    },
    redirect(code: number, url: string) {
      res.statusCode = code;
      res.location = url;
    },
  };
  return res;
}

function make(target: string | null) {
  const resolve = jest.fn().mockResolvedValue(target);
  const ctl = new ShortLinkRedirectController({
    resolve,
  } as unknown as ShortLinksService);
  return { ctl, resolve };
}

const req = (method: string) => ({ method }) as Request;

describe('GET /l/:code', () => {
  it('302s to the target and counts the click', async () => {
    const { ctl, resolve } = make('https://lumiere.pk/menu');
    const res = fakeRes();
    await ctl.redirect('abc1234', req('GET'), res as unknown as Response);
    expect(resolve).toHaveBeenCalledWith('abc1234', true);
    expect(res.statusCode).toBe(302);
    expect(res.location).toBe('https://lumiere.pk/menu');
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(res.headers['X-Robots-Tag']).toBe('noindex');
  });

  it('does not count a HEAD request', async () => {
    const { ctl, resolve } = make('https://lumiere.pk/menu');
    const res = fakeRes();
    await ctl.redirect('abc1234', req('HEAD'), res as unknown as Response);
    expect(resolve).toHaveBeenCalledWith('abc1234', false);
    expect(res.statusCode).toBe(302);
  });

  it('answers an unknown code with a plain-text 404', async () => {
    const { ctl } = make(null);
    const res = fakeRes();
    await ctl.redirect('nope', req('GET'), res as unknown as Response);
    expect(res.statusCode).toBe(404);
    expect(res.contentType).toBe('text/plain');
    expect(res.body).toBe(NOT_FOUND_TEXT);
    expect(res.location).toBeUndefined();
  });
});
