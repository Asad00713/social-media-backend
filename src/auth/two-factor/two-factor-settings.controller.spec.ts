import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SKIP_LAUNCH_GATE } from '../decorators/skip-launch-gate.decorator';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { EnableTwoFactorDto } from './dto/enable-two-factor.dto';
import { SecondFactorDto } from './dto/second-factor.dto';
import { SetupTwoFactorDto } from './dto/setup-two-factor.dto';
import {
  TwoFactorSettingsController,
  twoFactorTracker,
} from './two-factor-settings.controller';

const caller = {
  userId: 'u1',
  email: 'a@b.co',
  role: 'USER',
  sid: 's1',
  iat: 1,
} as never;

function build() {
  const twoFactor = {
    status: jest.fn().mockResolvedValue({ enabled: false }),
    setup: jest.fn().mockResolvedValue({ otpauthUrl: 'u', secretGrouped: 'g' }),
    enable: jest.fn().mockResolvedValue({ backupCodes: [], accessToken: 'a' }),
    regenerate: jest.fn().mockResolvedValue({ backupCodes: [] }),
    disable: jest.fn().mockResolvedValue(undefined),
  };
  return {
    controller: new TwoFactorSettingsController(twoFactor as never),
    twoFactor,
  };
}

const handler = (name: string) =>
  Reflect.get(TwoFactorSettingsController.prototype, name) as object;

describe('TwoFactorSettingsController wiring', () => {
  const req = { headers: {} } as never;
  const res = {} as never;

  it('passes the caller and the body through', async () => {
    const b = build();
    await b.controller.status(caller);
    expect(b.twoFactor.status).toHaveBeenCalledWith('u1');
    await b.controller.setup(caller, { currentPassword: 'pw' });
    expect(b.twoFactor.setup).toHaveBeenCalledWith(caller, {
      currentPassword: 'pw',
    });
    await b.controller.enable(caller, { code: '123456' }, req, res);
    expect(b.twoFactor.enable).toHaveBeenCalledWith(caller, '123456', req, res);
    await b.controller.regenerate(
      caller,
      { backupCode: 'ABCD-EFGH', currentPassword: 'ignored' },
      req,
    );
    // Only the factor reaches regenerate.
    expect(b.twoFactor.regenerate).toHaveBeenCalledWith(
      caller,
      { code: undefined, backupCode: 'ABCD-EFGH' },
      req,
    );
    await b.controller.disable(
      caller,
      { code: '123456', currentPassword: 'pw' },
      req,
    );
    expect(b.twoFactor.disable).toHaveBeenCalledWith(
      caller,
      { code: '123456', currentPassword: 'pw' },
      req,
    );
  });
});

describe('TwoFactorSettingsController metadata', () => {
  it('needs a signed-in user and skips the launch gate', () => {
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        TwoFactorSettingsController,
      ) as unknown[],
    ).toContain(JwtAuthGuard);
    expect(
      new Reflector().get<boolean>(
        SKIP_LAUNCH_GATE,
        TwoFactorSettingsController,
      ),
    ).toBe(true);
  });

  it.each(['setup', 'enable', 'regenerate', 'disable'])(
    '%s is throttled 10 an hour per user',
    (name) => {
      const h = handler(name);
      expect(Reflect.getMetadata(GUARDS_METADATA, h) as unknown[]).toContain(
        ThrottlerGuard,
      );
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', h)).toBe(10);
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', h)).toBe(3_600_000);
      expect(Reflect.getMetadata('THROTTLER:TRACKERdefault', h)).toBe(
        twoFactorTracker,
      );
    },
  );

  it('disable answers 204; setup, enable and regenerate 200', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler('disable'))).toBe(
      204,
    );
    for (const name of ['setup', 'enable', 'regenerate']) {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler(name))).toBe(200);
    }
  });

  it('the tracker keys by user, and is a 401 without one', () => {
    expect(twoFactorTracker({ user: { userId: 'u1' } })).toBe('2fa:u1');
    expect(() => twoFactorTracker({})).toThrow(UnauthorizedException);
  });
});

describe('two-step DTOs', () => {
  const errors = (cls: new () => object, body: object) =>
    validateSync(plainToInstance(cls, body), { whitelist: true }).map(
      (e) => e.property,
    );

  it('EnableTwoFactorDto needs a 6-digit code', () => {
    expect(errors(EnableTwoFactorDto, { code: '123456' })).toEqual([]);
    expect(errors(EnableTwoFactorDto, {})).toContain('code');
    expect(errors(EnableTwoFactorDto, { code: '12345' })).toContain('code');
  });

  it('SecondFactorDto takes a 6-digit code or a backup code (<= 32) and a password (<= 128)', () => {
    expect(errors(SecondFactorDto, { code: '123456' })).toEqual([]);
    expect(errors(SecondFactorDto, { backupCode: 'ABCD-EFGH' })).toEqual([]);
    expect(errors(SecondFactorDto, { code: 'abc' })).toContain('code');
    expect(errors(SecondFactorDto, { backupCode: 'A'.repeat(33) })).toContain(
      'backupCode',
    );
    expect(
      errors(SecondFactorDto, {
        code: '123456',
        currentPassword: 'p'.repeat(129),
      }),
    ).toContain('currentPassword');
  });

  it('SetupTwoFactorDto: currentPassword optional, <= 128', () => {
    expect(errors(SetupTwoFactorDto, {})).toEqual([]);
    expect(
      errors(SetupTwoFactorDto, { currentPassword: 'p'.repeat(129) }),
    ).toContain('currentPassword');
  });
});
