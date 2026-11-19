import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync, type ValidationError } from 'class-validator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BoundedJsonConstraint,
  EachValueOf,
  jsonShape,
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
} from './bounded-json';
import { bodyShapeMiddleware } from './body-shape.middleware';
import { CreatePostDto, PlatformContentDto } from '../../posts/dto/post.dto';

/**
 * The free-form corners of a request body.
 *
 * `@IsObject()` asks only "is this a non-null object", and two fields leaned
 * on it for more than that. Both payloads below were ACCEPTED before this
 * change, with the global pipe's `whitelist` + `forbidNonWhitelisted` on.
 */

const STRICT = { whitelist: true, forbidNonWhitelisted: true };

/**
 * Every message in the tree, not just the top level. `mediaItems[0].altText`
 * nests its error two levels down (`mediaItems` → `0` → `altText`), so a flat
 * read of `constraints` reports "" for a violation that did fire — which is
 * exactly what this helper did at first, making a working cap look broken.
 */
function messages(errors: ValidationError[]): string {
  return errors
    .flatMap((e) => [
      ...Object.values(e.constraints ?? {}),
      messages(e.children ?? []),
    ])
    .filter(Boolean)
    .join(' ');
}

const errs = (payload: unknown) =>
  messages(
    validateSync(plainToInstance(CreatePostDto, payload) as object, STRICT),
  );

const base = { targetChannelIds: ['1'] };

/** Deep JSON built as TEXT: `JSON.stringify` itself overflows past ~15k. */
const deepText = (n: number) => '{"n":'.repeat(n) + '{}' + '}'.repeat(n);

describe('jsonShape is iterative, by necessity', () => {
  /**
   * A recursive depth check would overflow on exactly the input it exists to
   * reject, which is the whole difficulty. V8's `JSON.parse` IS iterative, so
   * a 20,000-deep body parses without complaint and the crash lands in our
   * own stack afterwards.
   */
  it('measures a 20,000-deep object without overflowing', () => {
    const o: unknown = JSON.parse(deepText(20_000));
    expect(jsonShape(o).tooDeep).toBe(true);
  });

  it('stops at the ceiling instead of walking the whole payload', () => {
    const o: unknown = JSON.parse(deepText(20_000));
    // Bailed after a dozen nodes, not 20,000 - so a hostile body costs only
    // what the ceiling allows.
    expect(jsonShape(o).nodes).toBeLessThan(MAX_JSON_DEPTH + 5);
  });

  it('counts a wide payload as too big', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < MAX_JSON_NODES + 4_000; i++) wide[`k${i}`] = { a: 1 };
    expect(jsonShape(wide).tooBig).toBe(true);
  });

  it.each([
    ['a flat object', { a: 1, b: 'two' }],
    ['ordinary nesting', { campaign: 'q4', nested: { a: { b: { c: 1 } } } }],
    ['an array of objects', { items: [{ a: 1 }, { b: 2 }] }],
    ['null', null],
    ['a string', 'hello'],
  ])('passes %s', (_label, value) => {
    const r = jsonShape(value);
    expect({ tooDeep: r.tooDeep, tooBig: r.tooBig }).toEqual({
      tooDeep: false,
      tooBig: false,
    });
  });
});

describe('the depth guard runs as middleware, not as a validator', () => {
  /**
   * It was a `@Validate` on the field first, and that does not work:
   * `plainToInstance` recurses to build the DTO and the global
   * `ValidationPipe` runs it BEFORE any constraint, so the overflow happened
   * inside class-transformer with the field guard in place. Proven here by
   * driving the real DTO.
   */
  it('a deep body overflows class-transformer, so the field guard cannot fire', () => {
    const payload = { ...base, metadata: JSON.parse(deepText(5_000)) };
    expect(() => plainToInstance(CreatePostDto, payload)).toThrow(RangeError);
  });

  it('the middleware refuses it before that happens', () => {
    const req = { body: { ...base, metadata: JSON.parse(deepText(5_000)) } };
    const next = jest.fn();
    expect(() =>
      bodyShapeMiddleware()(req as never, {} as never, next),
    ).toThrow(/nested too deeply/);
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a body with too many entries', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < MAX_JSON_NODES + 4_000; i++) wide[`k${i}`] = { a: 1 };
    const next = jest.fn();
    expect(() =>
      bodyShapeMiddleware()({ body: wide } as never, {} as never, next),
    ).toThrow(/too many entries/);
  });

  it.each([
    ['an ordinary post', { ...base, content: 'hi', metadata: { a: { b: 1 } } }],
    ['no body at all', undefined],
    ['a string body', 'hello'],
  ])('lets %s through', (_label, body) => {
    const next = jest.fn();
    bodyShapeMiddleware()({ body } as never, {} as never, next);
    expect(next).toHaveBeenCalled();
  });

  it('is registered in main.ts after the parsers and before the pipe', () => {
    const main = readFileSync(join(__dirname, '../../main.ts'), 'utf8');
    const parser = main.indexOf("useBodyParser('json'");
    const guard = main.indexOf('bodyShapeMiddleware()');
    const pipe = main.indexOf('useGlobalPipes');
    expect(parser).toBeGreaterThan(-1);
    expect({ afterParser: guard > parser, beforePipe: guard < pipe }).toEqual({
      afterParser: true,
      beforePipe: true,
    });
  });
});

describe('platformContent values are validated', () => {
  /**
   * `PlatformContentDto` was declared, typed into both post DTOs, and never
   * validated. `@ValidateNested()` cannot express this: it validates an
   * object's OWN properties, and here those are platform names, not fields.
   */
  it('refuses a wrong field type inside one platform', () => {
    expect(
      errs({ ...base, platformContent: { twitter: { text: 12345 } } }),
    ).toMatch(/must be a string/);
  });

  it('refuses an unknown field inside one platform', () => {
    // The same strictness the global pipe gives a top-level body.
    expect(
      errs({
        ...base,
        platformContent: { twitter: { text: 'hi', junkField: 'x' } },
      }),
    ).toMatch(/junkField should not exist/);
  });

  it('refuses a key that is not a platform', () => {
    expect(
      errs({ ...base, platformContent: { myspace: { text: 'hi' } } }),
    ).toMatch(/unknown key/);
  });

  it('refuses a non-object value', () => {
    expect(errs({ ...base, platformContent: { twitter: 'hi' } })).toMatch(
      /must be an object/,
    );
  });

  it('accepts real per-platform content', () => {
    expect(
      errs({
        ...base,
        platformContent: {
          twitter: { text: 'hello', metadata: { a: 1 } },
          facebook: { text: 'x'.repeat(60_000) },
        },
      }),
    ).toBe('');
  });

  it('validates every key, not only the first', () => {
    // A loop that returned on its first success would miss this.
    expect(
      errs({
        ...base,
        platformContent: {
          twitter: { text: 'fine' },
          facebook: { text: 999 },
        },
      }),
    ).toMatch(/must be a string/);
  });

  it('EachValueOf passes an absent value', () => {
    const C = EachValueOf(PlatformContentDto, ['twitter']);
    expect(new C().validate(undefined)).toBe(true);
  });

  it('EachValueOf refuses an array', () => {
    const C = EachValueOf(PlatformContentDto, ['twitter']);
    expect(new C().validate([{ text: 'hi' }])).toBe(false);
  });
});

describe('a caption cannot be unbounded', () => {
  /**
   * A backstop, not a platform limit: the real caps are per platform and
   * enforced where the post is published. This only stops an unbounded string
   * reaching the database or a platform client.
   */
  it('refuses a 10MB content', () => {
    expect(errs({ ...base, content: 'a'.repeat(10 * 1024 * 1024) })).toMatch(
      /shorter than or equal to/,
    );
  });

  it('accepts the longest caption any platform allows (Facebook, 63,206)', () => {
    expect(errs({ ...base, content: 'a'.repeat(63_206) })).toBe('');
  });

  it('bounds altText too', () => {
    expect(
      errs({
        ...base,
        mediaItems: [
          {
            url: 'https://example.com/a.png',
            type: 'image',
            altText: 'a'.repeat(5_000),
          },
        ],
      }),
    ).toMatch(/shorter than or equal to/);
  });
});

describe('BoundedJsonConstraint, for the shapes that do reach it', () => {
  it('passes an absent value', () => {
    expect(new BoundedJsonConstraint().validate(undefined)).toBe(true);
  });

  it('refuses a non-object', () => {
    expect(new BoundedJsonConstraint().validate('hello')).toBe(false);
  });

  it('refuses a too-deep object', () => {
    expect(new BoundedJsonConstraint().validate(JSON.parse(deepText(50)))).toBe(
      false,
    );
  });

  it('accepts ordinary metadata', () => {
    expect(new BoundedJsonConstraint().validate({ a: { b: 1 } })).toBe(true);
  });
});
