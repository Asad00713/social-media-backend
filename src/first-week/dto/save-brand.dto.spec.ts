import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PostIdsDto } from './post-ids.dto';
import { SaveBrandDto } from './save-brand.dto';

const errorsOf = async (cls: any, body: unknown) =>
  (await validate(plainToInstance(cls, body))).map((e) => e.property);

const good = {
  sells: 'Small-batch coffee',
  voice: ['Warm', 'Local'],
  audience: 'Students nearby',
};

describe('SaveBrandDto', () => {
  it('accepts the spec example', async () => {
    expect(await errorsOf(SaveBrandDto, good)).toEqual([]);
  });

  it('accepts the exact limits (120 / 5 chips of 24 / 200)', async () => {
    expect(
      await errorsOf(SaveBrandDto, {
        sells: 's'.repeat(120),
        voice: ['a', 'b', 'c', 'd', 'x'.repeat(24)],
        audience: 'u'.repeat(200),
      }),
    ).toEqual([]);
  });

  it('rejects sells that is empty, blank or over 120', async () => {
    expect(await errorsOf(SaveBrandDto, { ...good, sells: '' })).toContain(
      'sells',
    );
    expect(await errorsOf(SaveBrandDto, { ...good, sells: '   ' })).toContain(
      'sells',
    );
    expect(
      await errorsOf(SaveBrandDto, { ...good, sells: 's'.repeat(121) }),
    ).toContain('sells');
  });

  it('rejects audience that is empty, blank or over 200', async () => {
    expect(await errorsOf(SaveBrandDto, { ...good, audience: '' })).toContain(
      'audience',
    );
    expect(await errorsOf(SaveBrandDto, { ...good, audience: '  ' })).toContain(
      'audience',
    );
    expect(
      await errorsOf(SaveBrandDto, { ...good, audience: 'u'.repeat(201) }),
    ).toContain('audience');
  });

  it('rejects voice with no chips, more than 5, or a chip over 24 characters', async () => {
    expect(await errorsOf(SaveBrandDto, { ...good, voice: [] })).toContain(
      'voice',
    );
    expect(
      await errorsOf(SaveBrandDto, {
        ...good,
        voice: ['a', 'b', 'c', 'd', 'e', 'f'],
      }),
    ).toContain('voice');
    expect(
      await errorsOf(SaveBrandDto, { ...good, voice: ['x'.repeat(25)] }),
    ).toContain('voice');
  });

  it('rejects a blank chip and non-string chips', async () => {
    expect(await errorsOf(SaveBrandDto, { ...good, voice: ['  '] })).toContain(
      'voice',
    );
    expect(await errorsOf(SaveBrandDto, { ...good, voice: [7] })).toContain(
      'voice',
    );
  });

  it('rejects missing fields', async () => {
    expect((await errorsOf(SaveBrandDto, {})).sort()).toEqual([
      'audience',
      'sells',
      'voice',
    ]);
  });
});

describe('PostIdsDto', () => {
  const ids = ['11111111-1111-4111-8111-111111111111'];

  it('accepts uuids', async () => {
    expect(await errorsOf(PostIdsDto, { postIds: ids })).toEqual([]);
  });

  it('rejects an empty list, a non-uuid, and more than 20 ids', async () => {
    expect(await errorsOf(PostIdsDto, { postIds: [] })).toContain('postIds');
    expect(await errorsOf(PostIdsDto, { postIds: ['nope'] })).toContain(
      'postIds',
    );
    expect(
      await errorsOf(PostIdsDto, { postIds: Array(21).fill(ids[0]) }),
    ).toContain('postIds');
  });

  it('rejects a missing list', async () => {
    expect(await errorsOf(PostIdsDto, {})).toContain('postIds');
  });
});
