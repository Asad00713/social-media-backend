import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ChangePasswordDto } from './change-password.dto';
import { UpdateUserDto } from './update-user.dto';

const errorsFor = async (body: object) =>
  validate(plainToInstance(UpdateUserDto, body));

describe('UpdateUserDto.name', () => {
  it('accepts a name of exactly 60 characters', async () => {
    expect(await errorsFor({ name: 'a'.repeat(60) })).toHaveLength(0);
  });

  it('rejects 61 characters with MaxLength', async () => {
    const errors = await errorsFor({ name: 'a'.repeat(61) });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('name');
    expect(errors[0].constraints).toHaveProperty('maxLength');
  });
});

describe('ChangePasswordDto.revokeOtherSessions', () => {
  const base = { newPassword: 'NewPass456' };
  const dtoErrors = async (body: object) =>
    validate(plainToInstance(ChangePasswordDto, body));

  it('is optional', async () => {
    expect(await dtoErrors(base)).toHaveLength(0);
  });

  it.each([true, false])('accepts %p', async (revokeOtherSessions) => {
    expect(await dtoErrors({ ...base, revokeOtherSessions })).toHaveLength(0);
  });

  it.each([['no'], [1], ['false']])(
    'rejects %p',
    async (revokeOtherSessions) => {
      const errors = await dtoErrors({ ...base, revokeOtherSessions });
      expect(errors.map((e) => e.property)).toContain('revokeOtherSessions');
    },
  );
});

describe('UpdateUserDto.useCase', () => {
  it.each(['own_brand', 'clients'])('accepts %s', async (useCase) => {
    expect(await errorsFor({ useCase })).toHaveLength(0);
  });

  it.each([['agency'], [''], [3]])('rejects %p', async (useCase) => {
    // Anything else would reach the enum column and fail as a 500 from
    // Postgres instead of a 400 the client can act on.
    const errors = await errorsFor({ useCase });
    expect(errors.map((e) => e.property)).toContain('useCase');
  });

  it('stays optional, so a name-only update is still valid', async () => {
    expect(await errorsFor({ name: 'Sara' })).toHaveLength(0);
  });
});
