import type { NextFunction, Request, Response } from 'express';
import type { DbType } from '../drizzle/db';
import { LogWriterService } from './log-writer.service';
import { requestContextMiddleware } from './request-context';

const ID = 'req_0123456789abcdef01234567';

function setup() {
  const values = jest.fn((_row: Record<string, unknown>) => ({
    catch: jest.fn(),
  }));
  const db = { insert: jest.fn(() => ({ values })) } as unknown as DbType;
  const writer = new LogWriterService(db);
  const row = (i = 0) => values.mock.calls[i][0];
  return { writer, row };
}

function insideRequest(fn: () => void) {
  const req = { headers: { 'x-request-id': ID } } as unknown as Request;
  const res = { setHeader: jest.fn() } as unknown as Response;
  requestContextMiddleware(req, res, fn as NextFunction);
}

describe('LogWriterService request id', () => {
  it('stores the id it is given', () => {
    const { writer, row } = setup();
    writer.write({ level: 'error', message: 'x', requestId: ID });
    expect(row().requestId).toBe(ID);
  });

  it('takes the id of the request it runs inside when none is given', () => {
    const { writer, row } = setup();
    insideRequest(() => writer.write({ level: 'error', message: 'x' }));
    expect(row().requestId).toBe(ID);
  });

  it('keeps an explicit null even inside a request', () => {
    const { writer, row } = setup();
    insideRequest(() =>
      writer.write({ level: 'warn', message: 'x', requestId: null }),
    );
    expect(row().requestId).toBeNull();
  });

  it('stores null outside any request (a queue worker, a cron)', () => {
    const { writer, row } = setup();
    writer.write({ level: 'error', message: 'x' });
    expect(row().requestId).toBeNull();
  });
});
