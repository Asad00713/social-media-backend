import { deviceLabel, deviceType } from './device-label';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD =
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const ANDROID_PHONE =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const SMART_TV =
  'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1';

describe('deviceType', () => {
  it('an iPhone is mobile', () => expect(deviceType(IPHONE)).toBe('mobile'));
  it('an Android phone is mobile', () =>
    expect(deviceType(ANDROID_PHONE)).toBe('mobile'));
  it('an iPad is tablet', () => expect(deviceType(IPAD)).toBe('tablet'));
  it('Chrome on Windows is desktop', () =>
    expect(deviceType(CHROME_WINDOWS)).toBe('desktop'));
  it('empty, missing and TV user agents are unknown', () => {
    expect(deviceType('')).toBe('unknown');
    expect(deviceType(null)).toBe('unknown');
    expect(deviceType(undefined)).toBe('unknown');
    expect(deviceType(SMART_TV)).toBe('unknown');
    expect(deviceType('curl/8.4.0')).toBe('unknown');
  });
});

describe('deviceLabel', () => {
  it('names browser and OS', () => {
    expect(deviceLabel(CHROME_WINDOWS)).toBe('Chrome on Windows');
    expect(deviceLabel(null)).toBe('Unknown browser');
  });
});
