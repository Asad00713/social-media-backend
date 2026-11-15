import {
  ComposerErrorMapperService,
  classifyPublishError,
} from './composer-error-mapper.service';

describe('ComposerErrorMapperService', () => {
  let mapper: ComposerErrorMapperService;
  beforeEach(() => {
    mapper = new ComposerErrorMapperService();
  });

  it('maps Twitter 401 messages to auth_failed', () => {
    const e = new Error('Request failed with status 401: invalid_token');
    expect(mapper.classify(e)).toEqual({
      code: 'auth_failed',
      retryable: false,
    });
  });

  it('maps "rate limit" messages to rate_limited (retryable)', () => {
    const e = new Error('Twitter API: 429 Too Many Requests');
    expect(mapper.classify(e)).toEqual({
      code: 'rate_limited',
      retryable: true,
    });
  });

  it('maps "media" validation errors to media_invalid', () => {
    const e = new Error('Failed to upload media to Twitter: file too large');
    expect(mapper.classify(e)).toEqual({
      code: 'media_invalid',
      retryable: false,
    });
  });

  it('maps duplicate content rejections to content_rejected', () => {
    const e = new Error('Status is a duplicate');
    expect(mapper.classify(e)).toEqual({
      code: 'content_rejected',
      retryable: false,
    });
  });

  it('maps network/timeout errors to transient (retryable)', () => {
    const e = new Error('ETIMEDOUT connecting to api.twitter.com');
    expect(mapper.classify(e)).toEqual({ code: 'transient', retryable: true });
  });

  it('defaults to permanent for unknown errors', () => {
    const e = new Error('Wat');
    expect(mapper.classify(e)).toEqual({ code: 'permanent', retryable: false });
  });
});

/**
 * The platforms' own words for the common failures, as the publishers pass
 * them on. One shared classifier serves Publish now (the composer) and the
 * scheduled job, so both name the same cause for the same message.
 */
describe('classifyPublishError - platform messages', () => {
  it.each([
    'Error validating access token: Session has expired on Friday, 14-Nov-25',
    'The access token has expired',
    'OAuthException: The user has not authorized application 123',
    'invalid_grant: refresh token revoked',
    'Unauthorized',
    'Request failed with status code 401',
  ])('auth_failed: %s', (message) => {
    expect(classifyPublishError(new Error(message)).code).toBe('auth_failed');
  });

  it.each([
    '(#4) Application request limit reached',
    '(#32) Page request limit reached',
    'Rate limit exceeded. Retry after 5 minutes',
    'Channel rate limit exceeded. Retry after 2 minutes',
    'spam_risk_too_many_posts',
    'The request cannot be completed because you have exceeded your quota.',
    'Request failed with status code 429',
  ])('rate_limited: %s', (message) => {
    expect(classifyPublishError(new Error(message))).toEqual({
      code: 'rate_limited',
      retryable: true,
    });
  });

  it.each([
    'Video is longer than 90 seconds.',
    'The video duration exceeds the maximum allowed',
    'The aspect ratio of this video is not supported.',
    'The aspect ratio is not supported.',
    'duration_check_failed',
    'Video file size exceeds the maximum of 300 MB',
    'Image is too large',
    'Video is too short to publish to YouTube',
    'Failed to download media from https://cdn.example.com/a.mp4',
    'Unsupported media type: gif',
    'The video resolution is too low',
  ])('media_invalid: %s', (message) => {
    expect(classifyPublishError(new Error(message)).code).toBe('media_invalid');
  });

  it.each([
    'Status is a duplicate.',
    'You are not allowed to create a Tweet with duplicate content.',
    'Content is a duplicate of urn:li:share:123',
    'Tweet text is too long',
    'Validation failed: Text too long',
    'Facebook content exceeds character limit',
    'Pinterest pin title cannot exceed 100 characters',
    'The video title is too long',
    'The caption is too long',
  ])('content_rejected: %s', (message) => {
    expect(classifyPublishError(new Error(message)).code).toBe(
      'content_rejected',
    );
  });

  it.each([
    'socket hang up',
    'connect ECONNREFUSED 1.2.3.4:443',
    'upstream 502',
    'Service Unavailable',
    'The service is temporarily unavailable',
  ])('transient: %s', (message) => {
    expect(classifyPublishError(new Error(message))).toEqual({
      code: 'transient',
      retryable: true,
    });
  });

  it('reads a bare string as well as an Error', () => {
    expect(classifyPublishError('Status is a duplicate').code).toBe(
      'content_rejected',
    );
  });

  it('does not read a number inside a larger one as a status code', () => {
    // "4010" is not HTTP 401, "15029" is not 502.
    expect(classifyPublishError('Item 4010 of 15029 was skipped').code).toBe(
      'permanent',
    );
  });

  it('keeps a requirement the platform states as permanent', () => {
    expect(classifyPublishError('Instagram Reels require a video').code).toBe(
      'permanent',
    );
  });
});
