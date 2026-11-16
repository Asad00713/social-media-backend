import {
  type ArgumentsHost,
  BadRequestException,
  GoneException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AllExceptionsFilter } from './all-exceptions.filter';
import type { LogWriterService } from './log-writer.service';
import { requestContextMiddleware } from './request-context';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOiJ4In0.c2ln-_x';

function runToken(url: string, exception: unknown) {
  const write = jest.fn<
    void,
    [{ path: string; message: string; stack: string }]
  >();
  const json = jest.fn();
  const response = { status: jest.fn(() => ({ json })) };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ url, method: 'POST' }),
    }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter({ write } as unknown as LogWriterService).catch(
    exception,
    host,
  );
  return { write, response, json };
}

describe('AllExceptionsFilter', () => {
  it('stores the path, message and stack of a token link without the token', () => {
    const err = new Error(`boom at /email/unsubscribe/${TOKEN}`);
    const { write } = runToken(`/email/unsubscribe/${TOKEN}?x=1`, err);
    const row = write.mock.calls[0][0];
    expect(row.path).toBe('/email/unsubscribe/[token]?x=1');
    expect(row.message).toBe('boom at /email/unsubscribe/[token]');
    expect(row.stack).not.toContain(TOKEN);
  });

  it('still answers with the exception it was given', () => {
    const { response, json } = runToken(
      `/reports/public/${TOKEN}`,
      new NotFoundException('gone'),
    );
    expect(response.status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'gone' }),
    );
  });

  it('leaves an ordinary url untouched', () => {
    const { write } = runToken('/posts?page=2', new Error('x'));
    expect(write.mock.calls[0][0].path).toBe('/posts?page=2');
  });
});

const LINK_TOKEN = 'Zk3v_-Q9pLmN0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123';

function run(exception: unknown, url: string, requestId?: string) {
  const write = jest.fn<
    void,
    [{ path: string | null; requestId?: string | null }]
  >();
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url, method: 'GET', requestId }),
    }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter({ write } as unknown as LogWriterService).catch(
    exception,
    host,
  );
  return { write, status, json };
}

describe('AllExceptionsFilter: connect links', () => {
  it('stores the path of a failed public connect-link request without its token', () => {
    const { write } = run(
      new GoneException('gone'),
      `/public/connect-links/${LINK_TOKEN}/instagram/start`,
    );
    const entry = write.mock.calls[0][0];
    expect(entry.path).toBe('/public/connect-links/[redacted]/instagram/start');
    expect(JSON.stringify(entry)).not.toContain(LINK_TOKEN);
  });

  it('stores the Facebook Pages path without its selection id', () => {
    const SEL = 'q7Yx2LmN0aBcDeFgHiJkLmNoPqRsTuVw';
    const { write } = run(
      new GoneException('gone'),
      `/public/connect-links/${LINK_TOKEN}/facebook/pages?selection=${SEL}`,
    );
    const entry = write.mock.calls[0][0];
    expect(entry.path).toBe(
      '/public/connect-links/[redacted]/facebook/pages?selection=[redacted]',
    );
    expect(JSON.stringify(entry)).not.toContain(SEL);
  });

  it("keeps the token out of the message and stack of Nest's route-not-found 404", () => {
    // Nest's own 404 for an unknown route spells the URL in its message:
    // "Cannot POST /public/connect-links/<token>/nope"
    const url = `/public/connect-links/${LINK_TOKEN}/nope`;
    const { write, json } = run(
      new NotFoundException(`Cannot POST ${url}`),
      url,
    );
    const entry = write.mock.calls[0][0] as unknown as {
      message: string;
      stack: string | null;
    };
    expect(entry.message).toBe(
      'Cannot POST /public/connect-links/[redacted]/nope',
    );
    expect(entry.stack).toContain('/public/connect-links/[redacted]/nope');
    expect(JSON.stringify(write.mock.calls[0][0])).not.toContain(LINK_TOKEN);
    // the response is unchanged: it goes back to whoever sent the token
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: `Cannot POST ${url}` }),
    );
  });

  it('still answers with the exception, and stores ordinary paths as they are', () => {
    const { write, status, json } = run(
      new NotFoundException('nope'),
      '/workspaces/1/channels',
    );
    expect(write.mock.calls[0][0].path).toBe('/workspaces/1/channels');
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalled();
  });

  describe('request id', () => {
    const ID = 'req_0123456789abcdef01234567';

    it('adds requestId to an HttpException body and keeps the rest as is', () => {
      const { json } = run(
        new BadRequestException(['name must be a string']),
        '/posts',
        ID,
      );
      expect(json).toHaveBeenCalledWith({
        message: ['name must be a string'],
        error: 'Bad Request',
        statusCode: 400,
        requestId: ID,
      });
    });

    it('adds requestId to the 500 body of an unknown error', () => {
      const { json, status } = run(new Error('db down'), '/posts', ID);
      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({
        statusCode: 500,
        message: 'Internal server error',
        requestId: ID,
      });
    });

    it('answers a string HttpException the way Nest does, plus requestId', () => {
      const { json } = run(new HttpException('Too late', 410), '/x', ID);
      expect(json).toHaveBeenCalledWith({
        statusCode: 410,
        message: 'Too late',
        requestId: ID,
      });
    });

    it('stores the same id on the log row', () => {
      const { write } = run(new Error('db down'), '/posts', ID);
      expect(write.mock.calls[0][0].requestId).toBe(ID);
    });

    it('falls back to the request scope when the request object has none', () => {
      const write = jest.fn<void, [{ requestId?: string | null }]>();
      const json = jest.fn();
      const req = {
        headers: { 'x-request-id': ID },
        url: '/posts',
        method: 'GET',
      };
      const res = { setHeader: jest.fn() };
      const host = {
        switchToHttp: () => ({
          getResponse: () => ({ status: () => ({ json }) }),
          // a different object than the one the middleware stamped
          getRequest: () => ({ url: '/posts', method: 'GET' }),
        }),
      } as unknown as ArgumentsHost;
      const filter = new AllExceptionsFilter({
        write,
      } as unknown as LogWriterService);
      const next: NextFunction = () => filter.catch(new Error('x'), host);
      requestContextMiddleware(
        req as unknown as Request,
        res as unknown as Response,
        next,
      );
      expect(write.mock.calls[0][0].requestId).toBe(ID);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: ID }),
      );
    });

    it('sends no requestId field when the request has no id at all', () => {
      const { json, write } = run(new NotFoundException('nope'), '/x');
      expect(json.mock.calls[0][0]).not.toHaveProperty('requestId');
      expect(write.mock.calls[0][0].requestId).toBeNull();
    });
  });
});
