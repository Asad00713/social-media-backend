import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdatePreferencesDto } from './update-preferences.dto';

const toDto = (body: object) => plainToInstance(UpdatePreferencesDto, body);
const errorsFor = async (body: object) => validate(toDto(body));
const props = (errors: Awaited<ReturnType<typeof errorsFor>>) =>
  errors.map((e) => e.property);

describe('UpdatePreferencesDto', () => {
  it('accepts an empty patch', async () => {
    expect(await errorsFor({})).toHaveLength(0);
  });

  it('accepts a full valid patch', async () => {
    expect(
      await errorsFor({
        theme: 'light',
        language: 'en',
        timezone: 'Asia/Karachi',
        timeFormat: '24h',
        weekStart: 'saturday',
        dateFormat: 'YYYY_MM_DD',
        startPage: 'last',
        hiddenModules: ['inbox', 'campaigns'],
        composerDefaultWhen: 'next_free_slot',
      }),
    ).toHaveLength(0);
  });

  describe('hiddenModules', () => {
    it('dedupes, keeping first-seen order', () => {
      expect(
        toDto({ hiddenModules: ['inbox', 'inbox', 'library'] }).hiddenModules,
      ).toEqual(['inbox', 'library']);
    });

    it('dedupes before the size check, so repeats of all four still pass', async () => {
      const body = {
        hiddenModules: [
          'inbox',
          'inbox',
          'library',
          'library',
          'insights',
          'campaigns',
        ],
      };
      expect(toDto(body).hiddenModules).toEqual([
        'inbox',
        'library',
        'insights',
        'campaigns',
      ]);
      expect(await errorsFor(body)).toHaveLength(0);
    });

    it('accepts an empty list', async () => {
      expect(await errorsFor({ hiddenModules: [] })).toHaveLength(0);
    });

    it.each([['home'], ['planner'], ['bogus']])(
      'rejects the module %p (Home and Planner always stay)',
      async (module) => {
        const errors = await errorsFor({ hiddenModules: [module, 'inbox'] });
        expect(props(errors)).toContain('hiddenModules');
        expect(errors[0].constraints).toHaveProperty('isIn');
      },
    );

    it('rejects a non-array', async () => {
      expect(props(await errorsFor({ hiddenModules: 'inbox' }))).toContain(
        'hiddenModules',
      );
    });
  });

  describe('timezone', () => {
    it('passes null (follow the device)', async () => {
      expect(await errorsFor({ timezone: null })).toHaveLength(0);
    });

    it('passes a real zone and UTC', async () => {
      expect(await errorsFor({ timezone: 'Europe/Paris' })).toHaveLength(0);
      expect(await errorsFor({ timezone: 'UTC' })).toHaveLength(0);
    });

    it.each(['Nowhere/X', '', 'utc+5'])('rejects %p', async (timezone) => {
      expect(props(await errorsFor({ timezone }))).toContain('timezone');
    });

    it('rejects a non-string', async () => {
      expect(props(await errorsFor({ timezone: 5 }))).toContain('timezone');
    });
  });

  it('rejects language "ur" (only shipped locales)', async () => {
    expect(props(await errorsFor({ language: 'ur' }))).toContain('language');
  });

  it.each([
    ['theme', 'blue'],
    ['timeFormat', '36h'],
    ['weekStart', 'friday'],
    ['dateFormat', 'DD-MM'],
    ['startPage', 'campaigns'],
    ['composerDefaultWhen', 'now'],
  ])('rejects an invalid %s', async (key, value) => {
    expect(props(await errorsFor({ [key]: value }))).toContain(key);
  });

  describe('through the app ValidationPipe (main.ts settings)', () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const run = (body: object) =>
      pipe.transform(body, {
        type: 'body',
        metatype: UpdatePreferencesDto,
      });

    it('rejects an unknown key with a 400 (it is not stripped)', async () => {
      await expect(run({ bogus: 1 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(run({ theme: 'dark', bogus: 1 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('lets a valid patch through, transformed', async () => {
      const dto = (await run({
        hiddenModules: ['inbox', 'inbox'],
        timezone: null,
      })) as UpdatePreferencesDto;
      expect(dto.hiddenModules).toEqual(['inbox']);
      expect(dto.timezone).toBeNull();
    });
  });
});
