import { registerDecorator, type ValidationOptions } from 'class-validator';

/** Area/Location[/Sub] or a bare name like UTC. Rejects offsets ("+05:00"). */
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

let canonical: Set<string> | null = null;

/**
 * Built on first use. `Intl.supportedValuesOf('timeZone')` does not list
 * `UTC` on every Node build, yet every workspace stores it, so it is added.
 */
function canonicalZones(): Set<string> {
  if (!canonical) {
    canonical = new Set<string>(Intl.supportedValuesOf('timeZone'));
    canonical.add('UTC');
  }
  return canonical;
}

/**
 * True for a real IANA time-zone id. The canonical list answers the common
 * case; the `Intl.DateTimeFormat` probe covers aliases the list omits
 * (`Asia/Calcutta`), which browsers still return from `resolvedOptions()`.
 */
export function isIanaTimeZone(value: string): boolean {
  if (typeof value !== 'string' || !ZONE_SHAPE.test(value)) return false;
  if (canonicalZones().has(value)) return true;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** class-validator decorator over {@link isIanaTimeZone}. */
export function IsIanaTimeZone(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) => {
    registerDecorator({
      name: 'isIanaTimeZone',
      target: target.constructor,
      propertyName: propertyName as string,
      options: {
        message: `${String(propertyName)} must be a valid IANA time zone`,
        ...options,
      },
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && isIanaTimeZone(value),
      },
    });
  };
}
