import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BatchInviteDto } from './batch-invite.dto';

const invites = [{ email: 'sana@x.pk', role: 'MEMBER' }];

async function check(message: unknown) {
  const dto = plainToInstance(BatchInviteDto, { invites, message });
  return { dto, errors: await validate(dto, { whitelist: true }) };
}

describe('BatchInviteDto.message', () => {
  it('is optional', async () => {
    const dto = plainToInstance(BatchInviteDto, { invites });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.message).toBeUndefined();
  });

  it('keeps a note of exactly 500 characters, trimmed', async () => {
    const { dto, errors } = await check(`  ${'a'.repeat(500)}  `);
    expect(errors).toHaveLength(0);
    expect(dto.message).toBe('a'.repeat(500));
  });

  it('refuses 501 characters', async () => {
    const { errors } = await check('a'.repeat(501));
    expect(errors.map((e) => e.property)).toEqual(['message']);
  });

  it.each(['', '   ', '\n\t'])(
    'a blank note (%j) becomes undefined',
    async (blank) => {
      const { dto, errors } = await check(blank);
      expect(errors).toHaveLength(0);
      expect(dto.message).toBeUndefined();
    },
  );

  it('refuses a non-string note', async () => {
    const { errors } = await check(42);
    expect(errors.map((e) => e.property)).toEqual(['message']);
  });
});
