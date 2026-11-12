import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { UpdateChannelDto } from './channel.dto';

// The global pipe, as main.ts configures it.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const validate = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: UpdateChannelDto });

describe('UpdateChannelDto', () => {
  it.each([false, true])(
    'refuses isActive=%s: only billing writes the plan lock',
    async (isActive) => {
      const err: unknown = await validate({ isActive }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BadRequestException);
      expect(
        JSON.stringify((err as BadRequestException).getResponse()),
      ).toContain('isActive');
    },
  );

  it('still accepts the editable fields', async () => {
    await expect(
      validate({ accountName: 'Renamed', color: '#ffffff', displayOrder: 2 }),
    ).resolves.toMatchObject({ accountName: 'Renamed', displayOrder: 2 });
  });
});
