import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateLabelDto, MergeLabelDto, UpdateLabelDto } from './label.dto';

type Ctor<T> = new () => T;

async function failing<T extends object>(
  cls: Ctor<T>,
  body: unknown,
): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, body) as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property);
}

describe('CreateLabelDto', () => {
  it('collapses inner whitespace and trims the name', () => {
    const dto = plainToInstance(CreateLabelDto, {
      name: '  Behind \t the\n  scenes ',
    });
    expect(dto.name).toBe('Behind the scenes');
  });

  it('accepts a name alone, and name + colour + description', async () => {
    expect(await failing(CreateLabelDto, { name: 'Promo' })).toEqual([]);
    expect(
      await failing(CreateLabelDto, {
        name: 'Promo',
        color: 'teal',
        description: 'Discounts and offers',
      }),
    ).toEqual([]);
  });

  it('accepts 40 characters and rejects 41', async () => {
    expect(await failing(CreateLabelDto, { name: 'a'.repeat(40) })).toEqual([]);
    expect(await failing(CreateLabelDto, { name: 'a'.repeat(41) })).toEqual([
      'name',
    ]);
  });

  it.each([
    ['missing', {}],
    ['null', { name: null }],
    ['a number', { name: 7 }],
    ['blank after trimming', { name: '   ' }],
  ])('rejects a name that is %s', async (_case, body) => {
    expect(await failing(CreateLabelDto, body)).toEqual(['name']);
  });

  it.each([
    ['null', null],
    ['off-palette', 'yellow'],
    ['a number', 3],
  ])('rejects a colour that is %s', async (_case, color) => {
    expect(await failing(CreateLabelDto, { name: 'Promo', color })).toEqual([
      'color',
    ]);
  });

  it('accepts a 120-character description and rejects 121, null or a number', async () => {
    expect(
      await failing(CreateLabelDto, {
        name: 'Promo',
        description: 'd'.repeat(120),
      }),
    ).toEqual([]);
    for (const description of ['d'.repeat(121), null, 5]) {
      expect(
        await failing(CreateLabelDto, { name: 'Promo', description }),
      ).toEqual(['description']);
    }
  });

  it('rejects unknown keys', async () => {
    expect(await failing(CreateLabelDto, { name: 'Promo', bogus: 1 })).toEqual([
      'bogus',
    ]);
  });
});

describe('UpdateLabelDto', () => {
  it('accepts an empty patch and each field alone', async () => {
    expect(await failing(UpdateLabelDto, {})).toEqual([]);
    expect(await failing(UpdateLabelDto, { name: 'Promo' })).toEqual([]);
    expect(await failing(UpdateLabelDto, { color: 'grey' })).toEqual([]);
    expect(await failing(UpdateLabelDto, { description: 'x' })).toEqual([]);
  });

  it('accepts description: null (clears it) and keeps the null', async () => {
    expect(await failing(UpdateLabelDto, { description: null })).toEqual([]);
    expect(
      plainToInstance(UpdateLabelDto, { description: null }).description,
    ).toBeNull();
  });

  it.each([
    ['name null', { name: null }, 'name'],
    ['name blank', { name: '  ' }, 'name'],
    ['name too long', { name: 'n'.repeat(41) }, 'name'],
    ['color null', { color: null }, 'color'],
    ['color off-palette', { color: 'black' }, 'color'],
    ['description too long', { description: 'd'.repeat(121) }, 'description'],
    ['description a number', { description: 12 }, 'description'],
  ])('rejects %s', async (_case, body, prop) => {
    expect(await failing(UpdateLabelDto, body)).toEqual([prop]);
  });

  it('normalises a renamed name like create does', () => {
    expect(plainToInstance(UpdateLabelDto, { name: ' A  B ' }).name).toBe(
      'A B',
    );
  });
});

describe('MergeLabelDto', () => {
  it('accepts a UUID', async () => {
    expect(
      await failing(MergeLabelDto, {
        intoId: '2b7f0f5e-3f0c-4b8e-9a39-7f4a7d1f9c11',
      }),
    ).toEqual([]);
  });

  it.each([
    ['missing', {}],
    ['null', { intoId: null }],
    ['not a UUID', { intoId: 'abc' }],
    ['a number', { intoId: 1 }],
  ])('rejects intoId %s', async (_case, body) => {
    expect(await failing(MergeLabelDto, body)).toEqual(['intoId']);
  });
});
