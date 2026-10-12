import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateUserDto } from './update-user.dto';

const errorsFor = async (body: object) =>
  validate(plainToInstance(UpdateUserDto, body));

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
