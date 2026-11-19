import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  validateSync,
} from 'class-validator';
import { plainToInstance } from 'class-transformer';

/**
 * Guards for the free-form JSON corners of our request bodies.
 *
 * `@IsObject()` asks only "is this a non-null object". Two request shapes
 * leaned on it for more than that and got nothing:
 *
 *   - `platformContent` is a `Record<platform, PlatformContentDto>`. The DTO
 *     was declared, typed into `CreatePostDto`/`UpdatePostDto`, and never
 *     validated: `@ValidateNested()` validates an object's OWN properties,
 *     and the properties here are platform names, not the fields. Measured
 *     before this change: `{ twitter: { text: 12345, junkField: 'x',
 *     mediaItems: 'not-an-array' } }` produced ZERO errors, even with the
 *     global pipe's `whitelist` + `forbidNonWhitelisted` on.
 *   - `metadata` is genuinely free-form, so there is nothing to validate it
 *     AGAINST - but it still must not be unbounded. A 5,000-deep nested
 *     object threw `RangeError: Maximum call stack size exceeded` inside
 *     class-validator itself. That payload fits easily under any sane body
 *     size limit, so a byte ceiling does not prevent it.
 */

/** How deep a free-form JSON value may nest, and how many nodes it may hold. */
export const MAX_JSON_DEPTH = 12;
export const MAX_JSON_NODES = 5_000;

/**
 * Depth and size of a plain JSON value, measured iteratively.
 *
 * Deliberately NOT recursive: the bug being fixed is a stack overflow on deep
 * input, and a recursive checker would overflow on exactly the payload it is
 * meant to reject. Stops as soon as either ceiling is passed, so a hostile
 * body costs no more than the ceiling allows.
 */
export function jsonShape(
  value: unknown,
  maxDepth: number = MAX_JSON_DEPTH,
  maxNodes: number = MAX_JSON_NODES,
): { depth: number; nodes: number; tooDeep: boolean; tooBig: boolean } {
  let nodes = 0;
  let deepest = 0;
  const stack: Array<{ v: unknown; d: number }> = [{ v: value, d: 0 }];

  while (stack.length > 0) {
    const { v, d } = stack.pop() as { v: unknown; d: number };
    if (v === null || typeof v !== 'object') continue;

    nodes += 1;
    if (d > deepest) deepest = d;
    if (d > maxDepth || nodes > maxNodes) {
      return {
        depth: deepest,
        nodes,
        tooDeep: d > maxDepth,
        tooBig: nodes > maxNodes,
      };
    }
    for (const child of Object.values(v as Record<string, unknown>)) {
      if (child !== null && typeof child === 'object') {
        stack.push({ v: child, d: d + 1 });
      }
    }
  }
  return { depth: deepest, nodes, tooDeep: false, tooBig: false };
}

/** A free-form JSON object that is bounded in depth and node count. */
@ValidatorConstraint({ name: 'boundedJson', async: false })
export class BoundedJsonConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value !== 'object') return false;
    const { tooDeep, tooBig } = jsonShape(value);
    return !tooDeep && !tooBig;
  }
  defaultMessage(args: ValidationArguments): string {
    return `${args.property} is nested too deeply or has too many entries (max depth ${MAX_JSON_DEPTH}, max ${MAX_JSON_NODES} entries)`;
  }
}

/**
 * Every VALUE of a record is validated against a DTO class, and every key
 * must be one of an allowed set.
 *
 * `@ValidateNested()` cannot express this: it validates the object's own
 * properties, which here are the keys (platform names), not the fields of
 * each value.
 */
export function EachValueOf<T extends object>(
  dto: new () => T,
  allowedKeys: readonly string[],
) {
  @ValidatorConstraint({ async: false })
  class EachValueConstraint implements ValidatorConstraintInterface {
    /** Not `private`: the class is returned, so TS requires a public shape. */
    failure = '';

    validate(value: unknown): boolean {
      if (value === undefined || value === null) return true;
      if (typeof value !== 'object' || Array.isArray(value)) {
        this.failure = 'must be an object';
        return false;
      }
      const allowed = new Set(allowedKeys);
      for (const [key, raw] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (!allowed.has(key)) {
          this.failure = `has an unknown key '${key}'`;
          return false;
        }
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          this.failure = `['${key}'] must be an object`;
          return false;
        }
        // The same strictness the global pipe applies to a top-level body, so
        // an unknown field inside one platform's content is refused too.
        const errors = validateSync(plainToInstance(dto, raw), {
          whitelist: true,
          forbidNonWhitelisted: true,
        });
        if (errors.length > 0) {
          this.failure = `['${key}'] ${errors
            .map((e) => Object.values(e.constraints ?? {}).join(', '))
            .join('; ')}`;
          return false;
        }
      }
      return true;
    }

    defaultMessage(args: ValidationArguments): string {
      return `${args.property} ${this.failure}`;
    }
  }
  return EachValueConstraint;
}
