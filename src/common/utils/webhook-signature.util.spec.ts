import { createHmac } from 'node:crypto';
import { verifyMetaSignature } from './webhook-signature.util';

describe('verifyMetaSignature', () => {
  const appSecret = 'test_app_secret';
  const rawBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  const goodSig =
    'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');

  it('accepts a valid signature', () => {
    expect(verifyMetaSignature({ appSecret, signatureHeader: goodSig, rawBody })).toBe(true);
  });
  it('rejects a tampered body', () => {
    expect(
      verifyMetaSignature({ appSecret, signatureHeader: goodSig, rawBody: rawBody + 'x' }),
    ).toBe(false);
  });
  it('rejects a missing/garbage header', () => {
    expect(verifyMetaSignature({ appSecret, signatureHeader: undefined, rawBody })).toBe(false);
    expect(verifyMetaSignature({ appSecret, signatureHeader: 'nope', rawBody })).toBe(false);
  });
});
