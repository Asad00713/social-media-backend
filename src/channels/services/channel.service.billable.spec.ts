import { isBillablePlatform } from '../../drizzle/schema/channels.schema';

describe('billable guard wiring', () => {
  // Guard predicate the service uses for enforce/increment/decrement.
  it('integrations are not billable, social + messaging are', () => {
    expect(isBillablePlatform('google_drive')).toBe(false);
    expect(isBillablePlatform('google_calendar')).toBe(false);
    expect(isBillablePlatform('onedrive')).toBe(false);
    expect(isBillablePlatform('facebook')).toBe(true);
    expect(isBillablePlatform('whatsapp')).toBe(true);
  });
});
