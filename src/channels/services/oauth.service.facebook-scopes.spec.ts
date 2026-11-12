import { PLATFORM_CONFIG } from '../../drizzle/schema/channels.schema';
import { facebookScopesFor } from './oauth.service';

describe('facebookScopesFor read_insights flag', () => {
  const saved = process.env.FACEBOOK_REQUEST_READ_INSIGHTS;
  afterEach(() => {
    if (saved === undefined) delete process.env.FACEBOOK_REQUEST_READ_INSIGHTS;
    else process.env.FACEBOOK_REQUEST_READ_INSIGHTS = saved;
  });

  it('leaves the connect scopes unchanged when the flag is unset', () => {
    delete process.env.FACEBOOK_REQUEST_READ_INSIGHTS;
    expect(facebookScopesFor('connect')).toEqual(
      PLATFORM_CONFIG.facebook.oauthScopes,
    );
    expect(facebookScopesFor()).not.toContain('read_insights');
  });

  it('does not add it for any value other than the string "true"', () => {
    for (const v of ['false', '1', 'TRUE', '']) {
      process.env.FACEBOOK_REQUEST_READ_INSIGHTS = v;
      expect(facebookScopesFor('connect')).not.toContain('read_insights');
    }
  });

  it('appends read_insights to the connect scopes when the flag is "true"', () => {
    process.env.FACEBOOK_REQUEST_READ_INSIGHTS = 'true';
    expect(facebookScopesFor('connect')).toEqual([
      ...PLATFORM_CONFIG.facebook.oauthScopes,
      'read_insights',
    ]);
  });

  it('does not mutate the shared PLATFORM_CONFIG scope list', () => {
    process.env.FACEBOOK_REQUEST_READ_INSIGHTS = 'true';
    facebookScopesFor('connect');
    expect(PLATFORM_CONFIG.facebook.oauthScopes).not.toContain('read_insights');
  });

  it('never adds it to the ads intent', () => {
    process.env.FACEBOOK_REQUEST_READ_INSIGHTS = 'true';
    expect(facebookScopesFor('ads')).not.toContain('read_insights');
  });
});
