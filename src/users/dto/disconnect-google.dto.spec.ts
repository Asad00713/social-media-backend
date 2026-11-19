import { ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { DisconnectGoogleDto } from './disconnect-google.dto';

// The same options main.ts installs globally.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const meta: ArgumentMetadata = { type: 'body', metatype: DisconnectGoogleDto };

const run = (body: unknown) => pipe.transform(body, meta);

describe('DisconnectGoogleDto', () => {
  it('accepts a password and passes it through untouched (no trimming)', async () => {
    const dto = (await run({ currentPassword: ' OldPass123 ' })) as {
      currentPassword: string;
    };
    expect(dto.currentPassword).toBe(' OldPass123 ');
  });

  it('accepts a password of exactly 128 characters', async () => {
    await expect(
      run({ currentPassword: 'a'.repeat(128) }),
    ).resolves.toBeDefined();
  });

  it.each([
    ['a missing body', undefined],
    ['an empty object', {}],
    ['null', { currentPassword: null }],
    ['an empty string', { currentPassword: '' }],
    ['a number', { currentPassword: 123456 }],
    ['an array', { currentPassword: ['OldPass123'] }],
    ['an object', { currentPassword: { $ne: '' } }],
    ['129 characters', { currentPassword: 'a'.repeat(129) }],
    ['an unknown key', { currentPassword: 'OldPass123', force: true }],
  ])('rejects %s with a 400', async (_name, body) => {
    await expect(run(body)).rejects.toMatchObject({ status: 400 });
  });
});
