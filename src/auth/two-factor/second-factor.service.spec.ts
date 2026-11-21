import { Logger } from '@nestjs/common';
import { SecondFactorService } from './second-factor.service';

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (
      e as { getResponse(): { code: string; message: string } }
    ).getResponse();
  }
};

describe('SecondFactorService', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  /** A db that must not be read: the input checks come first. */
  const untouchable = new Proxy(
    {},
    {
      get: () => {
        throw new Error('the database was read');
      },
    },
  );

  it('missing both fields → MFA_CODE_REQUIRED, before any read', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const s = new SecondFactorService(untouchable as never);
    for (const input of [{}, { code: '' }, { backupCode: '  ' }]) {
      expect(await codeOf(s.check('u1', input))).toMatchObject({
        code: 'MFA_CODE_REQUIRED',
        message: 'Enter the code from your authenticator app or a backup code.',
      });
    }
  });

  it('both fields → MFA_CODE_REQUIRED "Send a code or a backup code, not both."', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const s = new SecondFactorService(untouchable as never);
    expect(
      await codeOf(s.check('u1', { code: '123456', backupCode: 'ABCD-EFGH' })),
    ).toMatchObject({
      code: 'MFA_CODE_REQUIRED',
      message: 'Send a code or a backup code, not both.',
    });
  });

  it('production env without a pepper → the constructor throws (boot fails)', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MFA_CODE_PEPPER;
    expect(() => new SecondFactorService({} as never)).toThrow(
      /MFA_CODE_PEPPER/,
    );
  });

  it('a Railway service without a pepper → the constructor throws, whatever NODE_ENV says', () => {
    process.env.NODE_ENV = 'development';
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    delete process.env.MFA_CODE_PEPPER;
    expect(() => new SecondFactorService({} as never)).toThrow(
      /MFA_CODE_PEPPER/,
    );
  });

  it('locally with NODE_ENV unset and no pepper → boots on the dev default', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    delete process.env.NODE_ENV;
    delete process.env.MFA_CODE_PEPPER;
    delete process.env.RAILWAY_ENVIRONMENT_NAME;
    delete process.env.RAILWAY_ENVIRONMENT;
    delete process.env.RAILWAY_PROJECT_ID;
    expect(() => new SecondFactorService({} as never)).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});
