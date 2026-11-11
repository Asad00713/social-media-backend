import { ConsoleLogger } from '@nestjs/common';
import { AppLoggerService } from './app-logger.service';
import type { LogWriterService } from './log-writer.service';

describe('AppLoggerService.error', () => {
  let logger: AppLoggerService;
  let write: jest.Mock;

  beforeEach(() => {
    jest.spyOn(ConsoleLogger.prototype, 'error').mockImplementation(() => {});
    logger = new AppLoggerService();
    write = jest.fn();
    logger.setWriter({ write } as unknown as LogWriterService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('does not throw when the second argument is a caught error object', () => {
    const metaError = { error: { message: 'Invalid parameter', code: 100 } };
    expect(() =>
      logger.error('Failed to create Instagram video container:', metaError),
    ).not.toThrow();
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        message: expect.stringContaining('Invalid parameter'),
        stack: null,
      }),
    );
  });

  it('keeps the stack of an Error passed as the second argument', () => {
    const err = new Error('boom');
    logger.error('Failed:', err);
    const row = write.mock.calls[0][0];
    expect(row.message).toBe('Failed: boom');
    expect(row.stack).toBe(err.stack);
  });

  it('still reads a string stack and a string context', () => {
    const stack = 'Error: x\n    at foo (a.ts:1:1)';
    logger.error('m', stack, 'Ctx');
    expect(write.mock.calls[0][0]).toMatchObject({
      message: 'm',
      stack,
      context: 'Ctx',
    });
    logger.error('m2', 'OnlyContext');
    expect(write.mock.calls[1][0]).toMatchObject({
      message: 'm2',
      stack: null,
      context: 'OnlyContext',
    });
  });

  it('bounds a huge detail object', () => {
    logger.error('big', { blob: 'x'.repeat(50_000) });
    expect(write.mock.calls[0][0].message.length).toBeLessThanOrEqual(4000);
  });
});
