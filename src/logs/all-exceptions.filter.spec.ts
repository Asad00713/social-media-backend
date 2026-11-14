import { ArgumentsHost, NotFoundException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import type { LogWriterService } from './log-writer.service';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOiJ4In0.c2ln-_x';

function run(url: string, exception: unknown) {
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
    const { write } = run(`/email/unsubscribe/${TOKEN}?x=1`, err);
    const row = write.mock.calls[0][0];
    expect(row.path).toBe('/email/unsubscribe/[token]?x=1');
    expect(row.message).toBe('boom at /email/unsubscribe/[token]');
    expect(row.stack).not.toContain(TOKEN);
  });

  it('still answers with the exception it was given', () => {
    const { response, json } = run(
      `/reports/public/${TOKEN}`,
      new NotFoundException('gone'),
    );
    expect(response.status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'gone' }),
    );
  });

  it('leaves an ordinary url untouched', () => {
    const { write } = run('/posts?page=2', new Error('x'));
    expect(write.mock.calls[0][0].path).toBe('/posts?page=2');
  });
});
