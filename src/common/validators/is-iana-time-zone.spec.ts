import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IsIanaTimeZone, isIanaTimeZone } from './is-iana-time-zone';

describe('isIanaTimeZone', () => {
  it.each([
    'UTC',
    'Asia/Karachi',
    'America/Argentina/Buenos_Aires',
    'Europe/Paris',
  ])('accepts %s', (zone) => {
    expect(isIanaTimeZone(zone)).toBe(true);
  });

  // Aliases that Intl.supportedValuesOf omits but Intl.DateTimeFormat knows.
  it('accepts an alias the canonical list leaves out', () => {
    expect(isIanaTimeZone('Asia/Calcutta')).toBe(true);
  });

  it.each(['Mars/Olympus', '', 'utc+5', 'Asia/', 'not a zone'])(
    'rejects %p',
    (zone) => {
      expect(isIanaTimeZone(zone)).toBe(false);
    },
  );

  it.each([null, undefined, 5, {}, ['UTC']])(
    'rejects the non-string %p',
    (value) => {
      expect(isIanaTimeZone(value as never)).toBe(false);
    },
  );
});

describe('@IsIanaTimeZone', () => {
  class Probe {
    @IsIanaTimeZone()
    zone!: string;
  }
  const errorsFor = (zone: unknown) =>
    validate(plainToInstance(Probe, { zone }));

  it('passes a real zone', async () => {
    expect(await errorsFor('Asia/Karachi')).toHaveLength(0);
  });

  it('fails an unknown zone with the isIanaTimeZone constraint', async () => {
    const errors = await errorsFor('Nowhere/X');
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isIanaTimeZone');
  });
});
