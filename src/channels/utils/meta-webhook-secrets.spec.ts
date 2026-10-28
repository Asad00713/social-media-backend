import { createHmac } from 'node:crypto';
import {
  isValidMetaDelivery,
  metaSigningSecrets,
} from './meta-webhook-secrets';

const sign = (secret: string, body: Buffer) =>
  'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

describe('metaSigningSecrets', () => {
  it('lists the Instagram secret first, then the app secret', () => {
    expect(
      metaSigningSecrets('instagram', {
        INSTAGRAM_CLIENT_SECRET: 'ig',
        META_APP_SECRET: 'fb',
      }),
    ).toEqual(['ig', 'fb']);
  });

  it('skips unset secrets', () => {
    expect(metaSigningSecrets('threads', { META_APP_SECRET: 'fb' })).toEqual([
      'fb',
    ]);
  });

  it('drops blank secrets', () => {
    expect(metaSigningSecrets('facebook', { META_APP_SECRET: '  ' })).toEqual(
      [],
    );
  });
});

describe('metaSigningSecrets - Facebook app secret', () => {
  const env = {
    INSTAGRAM_CLIENT_SECRET: 'ig',
    META_APP_SECRET: 'meta',
    FACEBOOK_CLIENT_SECRET: 'fbclient',
    THREADS_CLIENT_SECRET: 'th',
  };

  it('facebook accepts META_APP_SECRET then FACEBOOK_CLIENT_SECRET', () => {
    expect(metaSigningSecrets('facebook', env)).toEqual(['meta', 'fbclient']);
  });

  it('instagram accepts its own, META_APP_SECRET, then FACEBOOK_CLIENT_SECRET', () => {
    expect(metaSigningSecrets('instagram', env)).toEqual([
      'ig',
      'meta',
      'fbclient',
    ]);
  });

  it('threads stays its own then META_APP_SECRET', () => {
    expect(metaSigningSecrets('threads', env)).toEqual(['th', 'meta']);
  });

  it('trims, drops blanks and de-duplicates', () => {
    expect(
      metaSigningSecrets('facebook', {
        META_APP_SECRET: ' same ',
        FACEBOOK_CLIENT_SECRET: 'same',
      }),
    ).toEqual(['same']);
    expect(
      metaSigningSecrets('instagram', {
        META_APP_SECRET: '  ',
        FACEBOOK_CLIENT_SECRET: 'fbclient',
      }),
    ).toEqual(['fbclient']);
  });

  it('verifies a delivery signed with FACEBOOK_CLIENT_SECRET', () => {
    const body = Buffer.from('{"a":1}');
    expect(
      isValidMetaDelivery('facebook', sign('fbclient', body), body, env),
    ).toBe(true);
    expect(
      isValidMetaDelivery('instagram', sign('fbclient', body), body, env),
    ).toBe(true);
    expect(
      isValidMetaDelivery('threads', sign('fbclient', body), body, env),
    ).toBe(false);
  });
});

describe('isValidMetaDelivery', () => {
  const env = { INSTAGRAM_CLIENT_SECRET: 'ig', META_APP_SECRET: 'fb' };
  const body = Buffer.from('{"a":1}');

  it('accepts a body signed with the Instagram secret', () => {
    expect(isValidMetaDelivery('instagram', sign('ig', body), body, env)).toBe(
      true,
    );
  });

  it('accepts a body signed with the app secret', () => {
    expect(isValidMetaDelivery('instagram', sign('fb', body), body, env)).toBe(
      true,
    );
  });

  it('rejects a body signed with an unknown secret', () => {
    expect(
      isValidMetaDelivery('instagram', sign('other', body), body, env),
    ).toBe(false);
  });

  it('does not accept the Instagram secret on the Facebook endpoint', () => {
    expect(
      isValidMetaDelivery('facebook', sign('ig', body), body, {
        INSTAGRAM_CLIENT_SECRET: 'ig',
      }),
    ).toBe(false);
  });

  it('rejects a missing raw body', () => {
    expect(
      isValidMetaDelivery('instagram', sign('ig', body), undefined, env),
    ).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(isValidMetaDelivery('instagram', undefined, body, env)).toBe(false);
  });

  it('rejects a non-sha256 header', () => {
    expect(isValidMetaDelivery('instagram', 'sha1=abc', body, env)).toBe(false);
  });

  it('rejects everything when no secret is configured', () => {
    expect(isValidMetaDelivery('instagram', sign('', body), body, {})).toBe(
      false,
    );
  });

  it('verifies over the exact raw bytes, not re-serialised JSON', () => {
    const raw = Buffer.from('{"text":"caf\\u00e9" ,  "a":1}');
    expect(isValidMetaDelivery('instagram', sign('ig', raw), raw, env)).toBe(
      true,
    );
  });
});
