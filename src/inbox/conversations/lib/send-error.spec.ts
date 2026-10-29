import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ChannelNotConnectedError,
  InboxSendError,
  ReplyWindowClosedError,
  toSendError,
} from './send-error';

function bodyOf(e: unknown): { status: number; body: unknown } {
  expect(e).toBeInstanceOf(InboxSendError);
  const ex = e as InboxSendError;
  return { status: ex.getStatus(), body: ex.getResponse() };
}

describe('toSendError', () => {
  it('the reply-window check (ReplyWindowClosedError) is 403 REPLY_WINDOW_CLOSED, not retryable', () => {
    expect(
      bodyOf(toSendError(new ReplyWindowClosedError('Window closed'))),
    ).toEqual({
      status: 403,
      body: {
        code: 'REPLY_WINDOW_CLOSED',
        message: 'Window closed',
        retryable: false,
      },
    });
  });

  it('a plain ForbiddenException (a workspace-access refusal) is NOT a closed window (D19)', () => {
    const forbidden = new ForbiddenException('Not a member');
    expect(toSendError(forbidden)).toBe(forbidden);
  });

  it('maps a channel that is not connected to 409 CHANNEL_DISCONNECTED', () => {
    const out = bodyOf(toSendError(new ChannelNotConnectedError()));
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({
      code: 'CHANNEL_DISCONNECTED',
      retryable: false,
    });
  });

  it.each([
    'Token has expired',
    'access revoked by user',
    'Unauthorized',
    'HTTP 401 from platform',
    'please reconnect the channel',
  ])('maps the auth failure "%s" to 409 CHANNEL_DISCONNECTED', (msg) => {
    const out = bodyOf(toSendError(new Error(msg)));
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({
      code: 'CHANNEL_DISCONNECTED',
      message: msg,
      retryable: false,
    });
  });

  it.each(['Rate limit hit', 'HTTP 429', 'Too many requests'])(
    'maps "%s" to 429 RATE_LIMITED, retryable',
    (msg) => {
      const out = bodyOf(toSendError(new Error(msg)));
      expect(out.status).toBe(429);
      expect(out.body).toMatchObject({
        code: 'RATE_LIMITED',
        message: msg,
        retryable: true,
      });
    },
  );

  it('maps any other adapter error to 502 PLATFORM_ERROR with the platform text', () => {
    expect(
      bodyOf(toSendError(new Error('Facebook said no: (#100) bad id'))),
    ).toEqual({
      status: 502,
      body: {
        code: 'PLATFORM_ERROR',
        message: 'Facebook said no: (#100) bad id',
        retryable: true,
      },
    });
  });

  it.each([
    'Could not generate a preview',
    'Failed to moderate the comment',
    'Integrated with the accelerated pipeline',
  ])('"%s" is NOT a rate limit: it stays 502 PLATFORM_ERROR', (msg) => {
    const out = bodyOf(toSendError(new Error(msg)));
    expect(out.status).toBe(502);
    expect(out.body).toMatchObject({ code: 'PLATFORM_ERROR' });
  });

  it.each([
    'rate limit reached',
    'Rate-limit exceeded for this app',
    'Too many requests',
    'HTTP 429 from platform',
  ])('"%s" is a rate limit', (msg) => {
    expect(bodyOf(toSendError(new Error(msg))).status).toBe(429);
  });

  it('maps a thrown non-Error value to PLATFORM_ERROR', () => {
    expect(bodyOf(toSendError('boom')).body).toMatchObject({
      code: 'PLATFORM_ERROR',
      message: 'boom',
    });
  });

  it.each([
    ['NotFoundException', new NotFoundException('x')],
    ['BadRequestException', new BadRequestException({ reason: 'r' })],
    [
      'REPLIED_FIRST ConflictException',
      new ConflictException({ code: 'REPLIED_FIRST' }),
    ],
  ])('passes %s through unchanged', (_n, err) => {
    expect(toSendError(err)).toBe(err);
  });

  it('passes an InboxSendError through unchanged', () => {
    const err = toSendError(new Error('HTTP 429'));
    expect(toSendError(err)).toBe(err);
  });
});

describe('toSendError({ fromPlatform: true })', () => {
  const platform = { fromPlatform: true };

  it('reclassifies the expired-token BadRequestException to 409 CHANNEL_DISCONNECTED', () => {
    const out = bodyOf(
      toSendError(
        new BadRequestException(
          'Access token has expired for this channel. Please reconnect.',
        ),
        platform,
      ),
    );
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({
      code: 'CHANNEL_DISCONNECTED',
      retryable: false,
    });
  });

  it('reclassifies a rate message to 429', () => {
    const out = bodyOf(
      toSendError(new BadRequestException('Rate limit exceeded'), platform),
    );
    expect(out.status).toBe(429);
    expect(out.body).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
  });

  it('reclassifies any other HttpException to 502 PLATFORM_ERROR', () => {
    const out = bodyOf(
      toSendError(
        new BadRequestException('Failed to delete post from Bluesky'),
        platform,
      ),
    );
    expect(out.status).toBe(502);
    expect(out.body).toMatchObject({
      code: 'PLATFORM_ERROR',
      message: 'Failed to delete post from Bluesky',
      retryable: true,
    });
  });

  it('keeps a deliberate 400 { reason }, a 404, a plan-locked 403 and an InboxSendError', () => {
    const reason = new BadRequestException({ reason: 'Up to 300' });
    const notFound = new NotFoundException('Channel not found');
    const locked = new ForbiddenException(
      'This channel is locked by your plan',
    );
    const window = new ReplyWindowClosedError();
    for (const e of [reason, notFound, locked, window]) {
      expect(toSendError(e, platform)).toBe(e);
    }
  });

  it('without the flag an HttpException still passes through (Task 18 callers)', () => {
    const e = new BadRequestException('Access token has expired');
    expect(toSendError(e)).toBe(e);
  });
});
