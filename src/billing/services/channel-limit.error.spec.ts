import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { channelLimitReached, errorCodeOf } from './channel-limit.error';

describe('channelLimitReached', () => {
  it('is a 403 with the standard fields, the code and the numbers', () => {
    const err = channelLimitReached(3, 3);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toEqual({
      statusCode: 403,
      error: 'Forbidden',
      code: 'CHANNEL_LIMIT_REACHED',
      used: 3,
      limit: 3,
      message:
        'Channel limit reached (3/3). Upgrade your plan or purchase additional channels.',
    });
    expect(err.message).toContain('Channel limit reached (3/3)');
  });
});

describe('errorCodeOf', () => {
  it('reads the code of a coded HttpException, nothing else', () => {
    expect(errorCodeOf(channelLimitReached(1, 1))).toBe(
      'CHANNEL_LIMIT_REACHED',
    );
    expect(errorCodeOf(new BadRequestException('plain'))).toBeNull();
    expect(errorCodeOf(new Error('x'))).toBeNull();
    expect(errorCodeOf({ getResponse: () => ({ code: 'FAKE' }) })).toBeNull();
    expect(errorCodeOf(undefined)).toBeNull();
  });
});
