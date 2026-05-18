import { ComposerErrorMapperService } from './composer-error-mapper.service';

describe('ComposerErrorMapperService', () => {
  let mapper: ComposerErrorMapperService;
  beforeEach(() => {
    mapper = new ComposerErrorMapperService();
  });

  it('maps Twitter 401 messages to auth_failed', () => {
    const e = new Error('Request failed with status 401: invalid_token');
    expect(mapper.classify(e)).toEqual({ code: 'auth_failed', retryable: false });
  });

  it('maps "rate limit" messages to rate_limited (retryable)', () => {
    const e = new Error('Twitter API: 429 Too Many Requests');
    expect(mapper.classify(e)).toEqual({ code: 'rate_limited', retryable: true });
  });

  it('maps "media" validation errors to media_invalid', () => {
    const e = new Error('Failed to upload media to Twitter: file too large');
    expect(mapper.classify(e)).toEqual({ code: 'media_invalid', retryable: false });
  });

  it('maps duplicate content rejections to content_rejected', () => {
    const e = new Error('Status is a duplicate');
    expect(mapper.classify(e)).toEqual({ code: 'content_rejected', retryable: false });
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
