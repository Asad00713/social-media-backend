import * as crypto from 'crypto';
import {
  PADDLE_SIGNATURE_MAX_AGE_MS,
  paddleSignedPayload,
  parsePaddleSignature,
  verifyPaddleSignature,
} from './paddle-signature.util';

const SECRET = 'pdl_ntfset_01test_secret';
const BODY = Buffer.from('{"event_type":"subscription.updated","data":{}}');
const NOW = new Date('2026-11-25T12:00:00.000Z');
const TS = String(Math.floor(NOW.getTime() / 1000));

function sign(body: Buffer, ts: string, secret = SECRET): string {
  return crypto
    .createHmac('sha256', secret)
    .update(paddleSignedPayload(ts, body))
    .digest('hex');
}

function header(body: Buffer, ts: string, secret = SECRET): string {
  return `ts=${ts};h1=${sign(body, ts, secret)}`;
}

describe('parsePaddleSignature', () => {
  it('reads the documented shape', () => {
    expect(
      parsePaddleSignature('ts=1671552777;h1=eb4d0dc8853be92b7f063b9f'),
    ).toEqual({ ts: '1671552777', h1: ['eb4d0dc8853be92b7f063b9f'] });
  });

  it('keeps EVERY h1, which rotation sends more than one of', () => {
    // Paddle signs with the old and the new secret while a secret is being
    // rotated. A parser that kept only the first would drop half the traffic
    // for the whole window the repetition exists to cover.
    expect(parsePaddleSignature('ts=1;h1=aa;h1=bb;h1=cc')?.h1).toEqual([
      'aa',
      'bb',
      'cc',
    ]);
  });

  it('tolerates whitespace around the parts', () => {
    expect(parsePaddleSignature(' ts = 1 ; h1 = aa ')).toEqual({
      ts: '1',
      h1: ['aa'],
    });
  });

  it('keeps a hash that itself contains "="', () => {
    // Split on the FIRST `=` only. Splitting on every one would truncate a
    // value and silently fail to match.
    expect(parsePaddleSignature('ts=1;h1=aa=bb')?.h1).toEqual(['aa=bb']);
  });

  it('is null without a timestamp or without a hash', () => {
    // Not an empty parts object: a caller looping over an empty h1 list
    // compares nothing, and "no mismatch found" must never read as success.
    expect(parsePaddleSignature('h1=aa')).toBeNull();
    expect(parsePaddleSignature('ts=1')).toBeNull();
    expect(parsePaddleSignature('')).toBeNull();
    expect(parsePaddleSignature(undefined)).toBeNull();
    expect(parsePaddleSignature('garbage')).toBeNull();
  });

  it('ignores an element with an empty value', () => {
    expect(parsePaddleSignature('ts=1;h1=;h1=aa')?.h1).toEqual(['aa']);
    expect(parsePaddleSignature('ts=;h1=aa')).toBeNull();
  });

  it('ignores unknown elements rather than failing', () => {
    // Paddle may add one; an unknown key must not take down verification.
    expect(parsePaddleSignature('ts=1;h2=xx;h1=aa')).toEqual({
      ts: '1',
      h1: ['aa'],
    });
  });
});

describe('paddleSignedPayload', () => {
  it('is the timestamp, a colon, then the RAW body', () => {
    expect(paddleSignedPayload('123', Buffer.from('{"a":1}')).toString()).toBe(
      '123:{"a":1}',
    );
  });

  it('preserves bytes a re-serialisation would change', () => {
    // Key order and whitespace are part of what was signed, which is why the
    // route must hand over `req.rawBody` and never a parsed-then-stringified
    // object.
    const raw = Buffer.from('{ "b":2,  "a":1 }');
    expect(paddleSignedPayload('1', raw).toString()).toBe('1:{ "b":2,  "a":1 }');
  });
});

describe('verifyPaddleSignature', () => {
  it('accepts a signature Paddle would send', () => {
    expect(
      verifyPaddleSignature(BODY, header(BODY, TS), SECRET, NOW),
    ).toEqual({ ok: true });
  });

  it('accepts when one of several h1 values matches', () => {
    // The rotation case, end to end.
    const good = sign(BODY, TS);
    const h = `ts=${TS};h1=${'0'.repeat(64)};h1=${good}`;
    expect(verifyPaddleSignature(BODY, h, SECRET, NOW)).toEqual({ ok: true });
  });

  it('rejects a body that changed by one byte', () => {
    const tampered = Buffer.from(BODY.toString().replace('updated', 'canceled'));
    expect(
      verifyPaddleSignature(tampered, header(BODY, TS), SECRET, NOW).ok,
    ).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(
      verifyPaddleSignature(BODY, header(BODY, TS, 'wrong'), SECRET, NOW),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects when the body alone was signed, not ts:body', () => {
    // The commonest way to get this wrong. It fails EVERY real webhook, which
    // looks like a bad secret and sends you to rotate one that was correct.
    const bodyOnly = crypto
      .createHmac('sha256', SECRET)
      .update(BODY)
      .digest('hex');
    expect(
      verifyPaddleSignature(BODY, `ts=${TS};h1=${bodyOnly}`, SECRET, NOW).ok,
    ).toBe(false);
  });

  it('fails CLOSED with no secret configured, before any comparison', () => {
    // An unverified billing webhook can cancel a subscription or mark an
    // account paid. Dropping it and letting Paddle retry is strictly safer
    // than trusting it because the server is misconfigured.
    expect(verifyPaddleSignature(BODY, header(BODY, TS), '', NOW)).toEqual({
      ok: false,
      reason: 'no-secret',
    });
    expect(
      verifyPaddleSignature(BODY, header(BODY, TS), undefined, NOW),
    ).toEqual({ ok: false, reason: 'no-secret' });
  });

  it('rejects a malformed header', () => {
    expect(verifyPaddleSignature(BODY, 'nonsense', SECRET, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyPaddleSignature(BODY, undefined, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a non-numeric timestamp as malformed, not stale', () => {
    const h = `ts=not-a-number;h1=${sign(BODY, 'not-a-number')}`;
    expect(verifyPaddleSignature(BODY, h, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a signature older than the window', () => {
    const old = String(
      Math.floor((NOW.getTime() - PADDLE_SIGNATURE_MAX_AGE_MS - 1000) / 1000),
    );
    expect(verifyPaddleSignature(BODY, header(BODY, old), SECRET, NOW)).toEqual(
      { ok: false, reason: 'stale' },
    );
  });

  it('rejects a timestamp from the FUTURE too', () => {
    // A clock that is ahead is as much a sign of a forged header as an old
    // one, so the age is compared absolutely.
    const ahead = String(
      Math.floor((NOW.getTime() + PADDLE_SIGNATURE_MAX_AGE_MS + 1000) / 1000),
    );
    expect(
      verifyPaddleSignature(BODY, header(BODY, ahead), SECRET, NOW),
    ).toEqual({ ok: false, reason: 'stale' });
  });

  it('accepts a delivery that is late but inside the window', () => {
    // Paddle's own example rejects anything over FIVE SECONDS old. A cold
    // start or a deploy rolling over puts legitimate deliveries past that, and
    // a webhook rejected for age is a subscription whose state never lands.
    const late = String(
      Math.floor((NOW.getTime() - (PADDLE_SIGNATURE_MAX_AGE_MS - 1000)) / 1000),
    );
    expect(verifyPaddleSignature(BODY, header(BODY, late), SECRET, NOW).ok).toBe(
      true,
    );
  });

  it('rejects a hash of the wrong length without throwing', () => {
    // `crypto.timingSafeEqual` THROWS on a length mismatch rather than
    // returning false, so a short hash would 500 the route instead of being
    // refused — and a 500 is a Paddle retry storm.
    expect(
      verifyPaddleSignature(BODY, `ts=${TS};h1=abcd`, SECRET, NOW),
    ).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a non-hex hash without throwing', () => {
    expect(
      verifyPaddleSignature(BODY, `ts=${TS};h1=zzzz`, SECRET, NOW).ok,
    ).toBe(false);
  });

  it('verifies an empty body rather than crashing on it', () => {
    const empty = Buffer.alloc(0);
    expect(
      verifyPaddleSignature(empty, header(empty, TS), SECRET, NOW).ok,
    ).toBe(true);
  });
});
