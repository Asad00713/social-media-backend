import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { UpdateChannelSettingsDto } from './channel-hub.dto';

// The global pipe, as main.ts configures it.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const validate = (body: unknown) =>
  pipe.transform(body, {
    type: 'body',
    metatype: UpdateChannelSettingsDto,
  }) as Promise<UpdateChannelSettingsDto>;

const refusal = async (body: unknown): Promise<string> => {
  const err: unknown = await validate(body).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(BadRequestException);
  return JSON.stringify((err as BadRequestException).getResponse());
};

describe('UpdateChannelSettingsDto', () => {
  it('trims the nickname', async () => {
    await expect(
      validate({ nickname: '  Daybreak Coffee  ' }),
    ).resolves.toMatchObject({ nickname: 'Daybreak Coffee' });
  });

  it('keeps null (clears the nickname) apart from a field left out', async () => {
    const cleared = await validate({ nickname: null });
    expect(cleared.nickname).toBeNull();
    const untouched = await validate({ showInSidebar: true });
    expect(untouched.nickname).toBeUndefined();
    expect(untouched.showInSidebar).toBe(true);
  });

  it('accepts exactly 80 characters after trimming', async () => {
    const nick = 'x'.repeat(80);
    await expect(validate({ nickname: ` ${nick} ` })).resolves.toMatchObject({
      nickname: nick,
    });
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['81 characters', 'x'.repeat(81)],
    ['a newline', 'Day\nbreak'],
    ['a tab', 'Day\tbreak'],
    ['a number', 42],
    ['an object', { name: 'x' }],
  ])('refuses a nickname that is %s', async (_label, nickname) => {
    expect(await refusal({ nickname })).toContain('nickname');
  });

  it.each([null, 'yes', 1])(
    'refuses showInSidebar=%p: only a boolean',
    async (showInSidebar) => {
      expect(await refusal({ showInSidebar })).toContain('showInSidebar');
    },
  );

  it('refuses fields that are not settings', async () => {
    expect(await refusal({ accountName: 'Renamed' })).toContain('accountName');
  });
});
