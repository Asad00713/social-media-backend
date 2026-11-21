import { Logger } from '@nestjs/common';
import { resolveMfaPepper } from './mfa-pepper';

describe('resolveMfaPepper', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('production without MFA_CODE_PEPPER throws naming the variable', () => {
    expect(() => resolveMfaPepper({ NODE_ENV: 'production' })).toThrow(
      /MFA_CODE_PEPPER/,
    );
  });

  it('production with a 31-char pepper throws', () => {
    expect(() =>
      resolveMfaPepper({
        NODE_ENV: 'production',
        MFA_CODE_PEPPER: 'x'.repeat(31),
      }),
    ).toThrow(/MFA_CODE_PEPPER/);
  });

  it('production with 32+ chars returns it', () => {
    const p = 'y'.repeat(32);
    expect(
      resolveMfaPepper({ NODE_ENV: 'production', MFA_CODE_PEPPER: p }),
    ).toBe(p);
    expect(warn).not.toHaveBeenCalled();
  });

  it('development without a pepper returns a non-empty default and warns', () => {
    const p = resolveMfaPepper({ NODE_ENV: 'development' });
    expect(p.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('development with a pepper set uses it', () => {
    expect(
      resolveMfaPepper({
        NODE_ENV: 'development',
        MFA_CODE_PEPPER: 'dev-pepper',
      }),
    ).toBe('dev-pepper');
  });
});
