import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateBrandKitDto } from './brand-kit.dto';

/** The global pipe's options: whitelist + forbidNonWhitelisted. */
async function errors(body: unknown): Promise<string[]> {
  const dto = plainToInstance(UpdateBrandKitDto, body);
  const result = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const flat: string[] = [];
  const walk = (es: typeof result, path: string) => {
    for (const e of es) {
      const p = path ? `${path}.${e.property}` : e.property;
      if (e.constraints) flat.push(p);
      if (e.children?.length) walk(e.children, p);
    }
  };
  walk(result, '');
  return flat;
}

describe('UpdateBrandKitDto', () => {
  it('accepts each field on its own, and a null logo', async () => {
    expect(await errors({ colors: ['#AABBCC'] })).toEqual([]);
    expect(await errors({ logoMediaId: null })).toEqual([]);
    expect(
      await errors({
        adjustPresets: [{ id: 'p1', name: 'Warm', values: { warmth: 20 } }],
      }),
    ).toEqual([]);
  });

  it('refuses a colour that is not #rrggbb, and more than 12', async () => {
    expect(await errors({ colors: ['red'] })).toEqual(['colors']);
    expect(await errors({ colors: ['#abc'] })).toEqual(['colors']);
    expect(await errors({ colors: Array(13).fill('#000000') })).toEqual([
      'colors',
    ]);
  });

  it('refuses a logo id that is not a uuid', async () => {
    expect(await errors({ logoMediaId: 'nope' })).toEqual(['logoMediaId']);
  });

  it('refuses out-of-range or unknown slider values', async () => {
    expect(
      await errors({
        adjustPresets: [{ id: 'p1', name: 'X', values: { warmth: 101 } }],
      }),
    ).toEqual(['adjustPresets.0.values.warmth']);
    expect(
      await errors({
        adjustPresets: [{ id: 'p1', name: 'X', values: { sharpen: -1 } }],
      }),
    ).toEqual(['adjustPresets.0.values.sharpen']);
    expect(
      await errors({
        adjustPresets: [{ id: 'p1', name: 'X', values: { bogus: 1 } }],
      }),
    ).toEqual(['adjustPresets.0.values.bogus']);
  });

  it('refuses an empty name, an odd id and more than 20 presets', async () => {
    const preset = { id: 'p1', name: 'X', values: {} };
    expect(
      await errors({ adjustPresets: [{ ...preset, name: '   ' }] }),
    ).toEqual(['adjustPresets.0.name']);
    expect(await errors({ adjustPresets: [{ ...preset, id: 'a b' }] })).toEqual(
      ['adjustPresets.0.id'],
    );
    expect(await errors({ adjustPresets: Array(21).fill(preset) })).toEqual([
      'adjustPresets',
    ]);
  });
});
