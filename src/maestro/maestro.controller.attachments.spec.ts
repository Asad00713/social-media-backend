/* eslint-disable @typescript-eslint/no-unsafe-member-access -- the controller is built with Object.create and its private collaborators are set by name */
import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';

// No real request may leave a test: both fetches are stubbed.
jest.mock('undici', () => ({
  ...jest.requireActual<typeof import('undici')>('undici'),
  fetch: jest.fn(() =>
    Promise.reject(new Error('undici fetch is stubbed in this spec')),
  ),
}));

import { MaestroController } from './maestro.controller';
import type { SendMaestroMessageDto } from './dto/send-message.dto';

/**
 * Attachment URLs arrive in the request body. The turn streams over SSE, so a
 * refusal inside the runtime could only be an SSE error event. The URLs are
 * checked BEFORE the stream opens, so a refused one is a real 400.
 */
describe('MaestroController.sendMessage attachment URLs', () => {
  const USER = { userId: 'u-1', email: 'u@example.com' };
  let streamMessage: jest.Mock;

  function build() {
    const controller = Object.create(
      MaestroController.prototype,
    ) as MaestroController;
    streamMessage = jest.fn(async function* () {
      yield* [];
    });
    (controller as any).maestro = { streamMessage };
    (controller as any).logger = { error: jest.fn(), log: jest.fn() };
    return controller;
  }
  const res = () => ({
    setHeader: jest.fn(),
    on: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    flushHeaders: jest.fn(),
  });
  const dto = (url: string) =>
    ({
      message: 'look',
      attachments: [
        { url, mediaType: 'image/png', kind: 'image', name: 'a.png', size: 1 },
      ],
    }) as unknown as SendMaestroMessageDto;

  beforeEach(() => {
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('global fetch is stubbed in this spec'));
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    'http://127.0.0.1/a.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.8/a.png',
    'http://[::1]/a.png',
    'http://localhost:8080/a.png',
    'file:///etc/passwd',
  ])('refuses %s with a 400 before the stream opens', async (url) => {
    const r = res();
    const err: unknown = await build()
      .sendMessage(USER, 'c-1', dto(url), r as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getStatus()).toBe(400);
    expect((err as BadRequestException).message).toBe(
      "That attachment link isn't reachable from the internet.",
    );
    expect(r.setHeader).not.toHaveBeenCalled();
    expect(streamMessage).not.toHaveBeenCalled();
  });

  it('streams a turn whose attachments are public', async () => {
    const r = res();
    await build().sendMessage(
      USER,
      'c-1',
      dto('https://93.184.216.34/a.png'),
      r as never,
    );
    expect(r.setHeader).toHaveBeenCalled();
    expect(streamMessage).toHaveBeenCalled();
  });
});
