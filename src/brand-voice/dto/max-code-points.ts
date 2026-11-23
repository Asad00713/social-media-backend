import {
  buildMessage,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';
import {
  BRAND_VOICE_LIMITS,
  codePointLength,
  TWEAK_PLATFORMS,
} from '../brand-voice.types';

/**
 * Validators for the brand-voice fields. Every length is counted in Unicode
 * code points, which is what the table's `char_length` CHECKs count.
 * class-validator's MaxLength counts UTF-16 units and `validator.js` strips
 * variation selectors, so a line of coffee emoji could pass it at 250 code
 * points and then fail the CHECK as a 500.
 */

const LINE_BREAK = /[\r\n]/;

/** Postgres rejects U+0000 in text and jsonb, which would surface as a 500. */
const hasNul = (value: string): boolean => value.includes('\u0000');

/** A string of at most `max` code points. Respects `{ each: true }`. */
export function MaxCodePoints(
  max: number,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'maxCodePoints',
      constraints: [max],
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && codePointLength(value) <= max,
        defaultMessage: buildMessage(
          (eachPrefix) =>
            `${eachPrefix}$property must be at most $constraint1 characters`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}

/** A string with no U+0000 (Postgres cannot store it). Respects `{ each: true }`. */
export function NoNulChars(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'noNulChars',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && !hasNul(value),
        defaultMessage: buildMessage(
          (eachPrefix) =>
            `${eachPrefix}$property must not contain a NUL character`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}

/** A string with no `\r` or `\n`: one line. Respects `{ each: true }`. */
export function NoLineBreaks(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'noLineBreaks',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && !LINE_BREAK.test(value),
        defaultMessage: buildMessage(
          (eachPrefix) => `${eachPrefix}$property must be a single line`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * A plain object whose keys are publishing platforms and whose values are
 * one-line strings without NUL, of at most 120 code points. An empty string is allowed:
 * it removes that platform's tweak.
 */
export function IsChannelTweaks(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  const platforms: readonly string[] = TWEAK_PLATFORMS;
  return ValidateBy(
    {
      name: 'isChannelTweaks',
      validator: {
        validate: (value: unknown) =>
          isPlainObject(value) &&
          Object.entries(value).every(
            ([platform, line]) =>
              platforms.includes(platform) &&
              typeof line === 'string' &&
              !LINE_BREAK.test(line) &&
              !hasNul(line) &&
              codePointLength(line) <= BRAND_VOICE_LIMITS.tweak,
          ),
        defaultMessage: buildMessage(
          (eachPrefix) =>
            `${eachPrefix}$property must map known platforms to one-line strings of at most ${BRAND_VOICE_LIMITS.tweak} characters`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}
