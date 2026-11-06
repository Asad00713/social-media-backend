import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { CreatePostDto } from './post.dto';

const STRICT = { whitelist: true, forbidNonWhitelisted: true };
const LIBRARY_ITEM_ID = '7a1d3c2e-5b4f-4e8a-9c6d-1f2e3a4b5c6d';

// The brief's 'https://x/a.png' fails @IsUrl() (it requires a TLD), so the
// first case could never pass; the host here has one.
function dto(libraryItemId: unknown): CreatePostDto {
  return plainToInstance(CreatePostDto, {
    content: 'Hello',
    targetChannelIds: ['1'],
    mediaItems: [{ url: 'https://x.io/a.png', type: 'image', libraryItemId }],
  });
}

/** Every leaf constraint name, so a nested failure is not hidden by its parent. */
function constraints(errors: ValidationError[]): string[] {
  return errors.flatMap((e) => [
    ...Object.keys(e.constraints ?? {}),
    ...constraints(e.children ?? []),
  ]);
}

describe('MediaItemDto.libraryItemId', () => {
  it('accepts a uuid libraryItemId under the global forbidNonWhitelisted pipe', async () => {
    const errors = await validate(dto(LIBRARY_ITEM_ID), STRICT);
    expect(constraints(errors)).toEqual([]);
  });

  it('rejects a libraryItemId that is not a uuid', async () => {
    const errors = await validate(dto('nope'), STRICT);
    expect(errors).toHaveLength(1);
    expect(constraints(errors)).toEqual(['isUuid']);
  });
});
