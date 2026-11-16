import type { Request, Response } from 'express';
import {
  REQUEST_ID_HEADER,
  currentRequestId,
  generateRequestId,
  isWellFormedRequestId,
  requestContextMiddleware,
  requestIdMiddleware,
  resolveRequestId,
} from './request-context';

function fakeReq(headers: Record<string, string | string[]> = {}): Request {
  return { headers } as unknown as Request;
}

function fakeRes() {
  const setHeader = jest.fn();
  return { res: { setHeader } as unknown as Response, setHeader };
}

describe('request ids', () => {
  it('generates req_ ids that pass its own check and differ each time', () => {
    const a = generateRequestId();
    const b = generateRequestId();
    expect(a).toMatch(/^req_[0-9a-f]{24}$/);
    expect(isWellFormedRequestId(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it.each([
    ['a uuid', true, '3f2b8c1e-9d4a-4e7b-8a6f-1c2d3e4f5a6b'],
    ['an upper-case uuid', true, '3F2B8C1E-9D4A-4E7B-8A6F-1C2D3E4F5A6B'],
    ['our own format', true, 'req_0123456789abcdef01234567'],
    ['an empty string', false, ''],
    ['a free-form string', false, 'hello world'],
    ['a log-injection attempt', false, 'req_abc\nERROR forged line'],
    ['an over-long req_ id', false, `req_${'a'.repeat(65)}`],
    ['a too-short req_ id', false, 'req_abc'],
    ['a uuid with trailing junk', false, '3f2b8c1e-9d4a-4e7b-8a6f-1c2d3e4f5a6b;x'],
  ])('%s is well-formed: %s', (_label, expected, value) => {
    expect(isWellFormedRequestId(value)).toBe(expected);
  });

  it('keeps a well-formed incoming X-Request-Id and echoes it', () => {
    const incoming = '3f2b8c1e-9d4a-4e7b-8a6f-1c2d3e4f5a6b';
    const req = fakeReq({ 'x-request-id': incoming });
    const { res, setHeader } = fakeRes();
    expect(resolveRequestId(req, res)).toBe(incoming);
    expect(req.requestId).toBe(incoming);
    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, incoming);
  });

  it('replaces a malformed incoming X-Request-Id with a generated one', () => {
    const req = fakeReq({ 'x-request-id': 'nope\r\nSet-Cookie: x=1' });
    const { res, setHeader } = fakeRes();
    const id = resolveRequestId(req, res);
    expect(id).toMatch(/^req_[0-9a-f]{24}$/);
    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, id);
  });

  it('ignores a repeated X-Request-Id header (array) and generates one', () => {
    const req = fakeReq({
      'x-request-id': ['req_0123456789abcdef01234567', 'req_aaaaaaaaaaaaaaaaaaaaaaaa'],
    });
    const { res } = fakeRes();
    expect(resolveRequestId(req, res)).toMatch(/^req_[0-9a-f]{24}$/);
  });

  it('generates one when there is no incoming header', () => {
    const { res, setHeader } = fakeRes();
    const id = resolveRequestId(fakeReq(), res);
    expect(id).toMatch(/^req_/);
    expect(setHeader).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a second pass keeps the id the first pass chose', () => {
    const req = fakeReq();
    const { res, setHeader } = fakeRes();
    const first = resolveRequestId(req, res);
    const second = resolveRequestId(req, res);
    expect(second).toBe(first);
    expect(setHeader).toHaveBeenCalledTimes(1);
  });

  it('requestIdMiddleware stamps the request and calls next', () => {
    const req = fakeReq();
    const { res, setHeader } = fakeRes();
    const next = jest.fn();
    requestIdMiddleware(req, res, next);
    expect(req.requestId).toMatch(/^req_/);
    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, req.requestId);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('requestContextMiddleware exposes the id to code running downstream', () => {
    const req = fakeReq();
    const { res } = fakeRes();
    let seen: string | undefined;
    requestContextMiddleware(req, res, () => {
      seen = currentRequestId();
    });
    expect(seen).toBe(req.requestId);
    // outside the request the context is gone
    expect(currentRequestId()).toBeUndefined();
  });

  it('keeps the context across an await downstream', async () => {
    const req = fakeReq({ 'x-request-id': 'req_0123456789abcdef01234567' });
    const { res } = fakeRes();
    const seen = await new Promise<string | undefined>((resolve) => {
      requestContextMiddleware(req, res, () => {
        void (async () => {
          await new Promise((r) => setTimeout(r, 1));
          resolve(currentRequestId());
        })();
      });
    });
    expect(seen).toBe('req_0123456789abcdef01234567');
  });
});
