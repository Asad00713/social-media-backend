import { ValidateBy, type ValidationOptions } from 'class-validator';

/**
 * Whether a channel id names a real channel row: a positive whole number,
 * as a string (the composer's shape) or a number.
 *
 * `Number('')` is `0`, and `0` is finite, so an empty id used to pass every
 * check after it and reach the database as channel 0. A template applied in
 * the composer could produce exactly that (`channelId: ''` placeholders).
 */
export function isRealChannelId(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0;
  }
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return /^[1-9]\d*$/.test(trimmed) && Number.isSafeInteger(Number(trimmed));
}

export const REAL_CHANNEL_ID_MESSAGE =
  'Every channel needs a real channel id. One is empty or 0 - pick the channel again in the composer.';

/** Every `channels[i].channelId` is a real channel id. */
export function HasRealChannelIds(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'hasRealChannelIds',
      validator: {
        validate: (value: unknown): boolean =>
          Array.isArray(value) &&
          value.every(
            (c) =>
              typeof c === 'object' &&
              c !== null &&
              isRealChannelId((c as { channelId?: unknown }).channelId),
          ),
        defaultMessage: (): string => REAL_CHANNEL_ID_MESSAGE,
      },
    },
    validationOptions,
  );
}
