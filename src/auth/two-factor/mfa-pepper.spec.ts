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

  describe('fails closed in production', () => {
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

    it('production with 32+ chars returns it, without a warning', () => {
      const p = 'y'.repeat(32);
      expect(
        resolveMfaPepper({ NODE_ENV: 'production', MFA_CODE_PEPPER: p }),
      ).toBe(p);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(['Production', ' production '])(
      'NODE_ENV=%p counts as production (no case/space escape)',
      (nodeEnv) => {
        expect(() => resolveMfaPepper({ NODE_ENV: nodeEnv })).toThrow(
          /MFA_CODE_PEPPER/,
        );
      },
    );
  });

  describe('fails closed on Railway, whatever NODE_ENV says', () => {
    it.each([
      'RAILWAY_ENVIRONMENT_NAME',
      'RAILWAY_ENVIRONMENT',
      'RAILWAY_PROJECT_ID',
    ])('%s set, NODE_ENV unset, no pepper → throws', (name) => {
      expect(() => resolveMfaPepper({ [name]: 'production' })).toThrow(
        /MFA_CODE_PEPPER/,
      );
    });

    it.each(['development', 'test', undefined])(
      'Railway with NODE_ENV=%p and no pepper still throws',
      (nodeEnv) => {
        const env: NodeJS.ProcessEnv = { RAILWAY_PROJECT_ID: 'abc' };
        if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
        expect(() => resolveMfaPepper(env)).toThrow(/MFA_CODE_PEPPER/);
      },
    );

    it('Railway with a short pepper throws', () => {
      expect(() =>
        resolveMfaPepper({
          RAILWAY_ENVIRONMENT_NAME: 'staging',
          MFA_CODE_PEPPER: 'short',
        }),
      ).toThrow(/MFA_CODE_PEPPER/);
    });

    it('Railway with 32+ chars returns it', () => {
      const p = 'z'.repeat(40);
      expect(
        resolveMfaPepper({ RAILWAY_ENVIRONMENT: 'dev', MFA_CODE_PEPPER: p }),
      ).toBe(p);
      expect(warn).not.toHaveBeenCalled();
    });

    it('an empty Railway variable does not count as Railway', () => {
      expect(
        resolveMfaPepper({ RAILWAY_PROJECT_ID: '' }).length,
      ).toBeGreaterThan(0);
    });
  });

  describe('local (not production, not Railway): dev default + warning', () => {
    it.each([undefined, '', 'development', 'test', 'staging', 'dev'])(
      'NODE_ENV=%p without a pepper returns the dev default and warns once',
      (nodeEnv) => {
        const p = resolveMfaPepper(
          nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv },
        );
        expect(p.length).toBeGreaterThan(0);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          expect.stringMatching(/MFA_CODE_PEPPER/),
        );
      },
    );

    it('a pepper set locally is used as is, without a warning', () => {
      expect(resolveMfaPepper({ MFA_CODE_PEPPER: 'dev-pepper' })).toBe(
        'dev-pepper',
      );
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
