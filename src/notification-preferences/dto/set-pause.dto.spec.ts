import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SetPauseDto } from './set-pause.dto';

const errorsFor = (body: object) =>
  validate(plainToInstance(SetPauseDto, body));
const props = (errors: Awaited<ReturnType<typeof errorsFor>>) =>
  errors.map((e) => e.property);

describe('SetPauseDto', () => {
  it('accepts an ISO 8601 instant', async () => {
    expect(await errorsFor({ until: '2026-12-01T10:30:00.000Z' })).toHaveLength(
      0,
    );
    expect(
      await errorsFor({ until: '2026-12-01T10:30:00+05:00' }),
    ).toHaveLength(0);
  });

  it('accepts an explicit null, which clears the pause', async () => {
    expect(await errorsFor({ until: null })).toHaveLength(0);
  });

  it('rejects a missing until: omitting it must not read as "clear"', async () => {
    expect(props(await errorsFor({}))).toEqual(['until']);
  });

  it.each([
    ['a non-date string', 'tomorrow'],
    ['an empty string', ''],
    ['an impossible calendar date', '2026-02-31T10:00:00Z'],
    ['a date with no time', '2026-12-01'],
    ['a time with no zone', '2026-12-01T10:30:00'],
    ['a number', 1_800_000_000_000],
    ['a boolean', false],
    ['an object', {}],
  ])('rejects %s', async (_label, until) => {
    expect(props(await errorsFor({ until }))).toEqual(['until']);
  });

  it('is a 400 through the real pipe when until is invalid, and passes null', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const meta = { type: 'body' as const, metatype: SetPauseDto };
    await expect(pipe.transform({ until: 'soon' }, meta)).rejects.toThrow();
    await expect(pipe.transform({}, meta)).rejects.toThrow();
    await expect(
      pipe.transform({ until: 1, extra: 1 }, meta),
    ).rejects.toThrow();
    await expect(pipe.transform({ until: null }, meta)).resolves.toEqual({
      until: null,
    });
  });
});
