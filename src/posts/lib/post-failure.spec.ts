import { describeFailure } from './post-failure';

describe('describeFailure', () => {
  it('auth_failed asks to reconnect', () => {
    const expected = {
      message:
        'Facebook logged you out. Reconnect, then retry. Nothing was posted.',
      needsReconnect: true,
    };
    expect(
      describeFailure({ platform: 'facebook', errorCode: 'auth_failed' }),
    ).toEqual(expected);
    expect(
      describeFailure({
        platform: 'facebook',
        errorMessage: '401 Unauthorized',
      }),
    ).toEqual(expected);
    expect(
      describeFailure({
        platform: 'facebook',
        errorMessage: 'The access token has expired',
      }),
    ).toEqual(expected);
  });

  it.each([
    [
      'rate_limited',
      'Facebook is limiting how often you can post. Wait a little, then retry.',
    ],
    [
      'media_invalid',
      'Facebook rejected the media. Check the file type and size, then edit the post.',
    ],
    ['content_rejected', 'Facebook rejected this post. Edit it and try again.'],
    ['transient', "We couldn't reach Facebook. Try again in a moment."],
  ] as const)('%s', (errorCode, message) => {
    expect(describeFailure({ platform: 'facebook', errorCode })).toEqual({
      message,
      needsReconnect: false,
    });
  });

  it('permanent keeps the platform text', () => {
    expect(
      describeFailure({
        platform: 'facebook',
        errorCode: 'permanent',
        errorMessage: 'Weird platform thing',
      }),
    ).toEqual({ message: 'Weird platform thing', needsReconnect: false });
  });

  it('falls back when nothing is known', () => {
    expect(describeFailure({ platform: 'facebook' })).toEqual({
      message: 'Facebook could not publish this post.',
      needsReconnect: false,
    });
    expect(
      describeFailure({ platform: 'twitter', errorMessage: '' }).message,
    ).toBe('X (Twitter) could not publish this post.');
  });

  it('survives a platform missing from PLATFORM_CONFIG', () => {
    expect(
      describeFailure({
        platform: 'myspace' as never,
        errorCode: 'rate_limited',
      }).message,
    ).toBe(
      'myspace is limiting how often you can post. Wait a little, then retry.',
    );
  });
});
