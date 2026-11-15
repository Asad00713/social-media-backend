import type { Response } from 'express';
import { setRefreshCookie } from '../refresh-cookie';
import {
  DEVICE_COOKIE,
  deviceCookieOf,
  readOrMintDeviceId,
  setDeviceCookie,
} from './device-cookie';

const VALID = 'A'.repeat(21) + '_-' + 'z9'.repeat(10);

describe('readOrMintDeviceId', () => {
  it('keeps a well-formed cookie', () => {
    expect(VALID).toHaveLength(43);
    expect(readOrMintDeviceId(VALID)).toEqual({ id: VALID, isNew: false });
  });

  it('mints a 43-char base64url id when there is no cookie', () => {
    const minted = readOrMintDeviceId(undefined);
    expect(minted.isNew).toBe(true);
    expect(minted.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readOrMintDeviceId(undefined).id).not.toBe(minted.id);
  });

  it.each([
    ['empty', ''],
    ['too short', VALID.slice(1)],
    ['too long', VALID + 'a'],
    ['padding', VALID.slice(1) + '='],
    ['standard base64', VALID.slice(1) + '+'],
    ['injection', VALID.slice(3) + '; a'],
  ])('a malformed cookie (%s) is replaced with a new id', (_name, cookie) => {
    const r = readOrMintDeviceId(cookie);
    expect(r.isNew).toBe(true);
    expect(r.id).not.toBe(cookie);
    expect(r.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  // cookie-parser JSON-decodes `j:` cookies: `sd_device=j:["…"]` arrives as
  // an array, which a regex test would coerce into a match.
  it.each([
    ['a JSON array of a valid id', [VALID]],
    ['a JSON object', {}],
    ['a number', 1234],
    ['null', null],
    ['an over-long string', 'A'.repeat(4096)],
  ])('%s is not an id: a fresh one is minted', (_name, cookie) => {
    const r = readOrMintDeviceId(cookie);
    expect(r.isNew).toBe(true);
    expect(typeof r.id).toBe('string');
    expect(r.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.id).not.toBe(VALID);
  });
});

describe('deviceCookieOf', () => {
  it('reads sd_device from the parsed cookies, whatever its type', () => {
    expect(deviceCookieOf({ sd_device: VALID })).toBe(VALID);
    expect(deviceCookieOf({ sd_device: [VALID] })).toEqual([VALID]);
    expect(deviceCookieOf({})).toBeUndefined();
    expect(deviceCookieOf(undefined)).toBeUndefined();
  });
});

describe('setDeviceCookie', () => {
  it('sets sd_device with the refresh cookie options, for 400 days', () => {
    const cookie = jest.fn();
    setDeviceCookie({ cookie } as unknown as Response, VALID);
    expect(DEVICE_COOKIE).toBe('sd_device');
    expect(cookie).toHaveBeenCalledWith('sd_device', VALID, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 400 * 24 * 60 * 60 * 1000,
    });
  });

  it('matches the refresh cookie except for its lifetime (cross-site frontend)', () => {
    const cookie = jest.fn();
    const res = { cookie } as unknown as Response;
    setRefreshCookie(res, 'refresh');
    setDeviceCookie(res, VALID);
    const [refreshOptions, deviceOptions] = cookie.mock.calls.map(
      (call: unknown[]) => ({ ...(call[2] as object), maxAge: 'ignored' }),
    );
    expect(deviceOptions).toEqual(refreshOptions);
  });
});
