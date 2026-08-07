import {
  SUPPORTED_PLATFORMS,
  CHANNEL_CATEGORY,
  isBillablePlatform,
} from './channels.schema';

describe('CHANNEL_CATEGORY', () => {
  it('assigns a category to every supported platform (tripwire for new platforms)', () => {
    for (const p of SUPPORTED_PLATFORMS) {
      expect(CHANNEL_CATEGORY[p]).toBeDefined();
    }
  });

  it('categorizes the integration platforms as integration', () => {
    for (const p of [
      'google_drive', 'google_photos', 'onedrive', 'dropbox',
      'google_calendar', 'outlook_calendar',
    ] as const) {
      expect(CHANNEL_CATEGORY[p]).toBe('integration');
    }
  });

  it('categorizes messaging platforms as messaging', () => {
    for (const p of ['slack', 'telegram', 'discord', 'whatsapp'] as const) {
      expect(CHANNEL_CATEGORY[p]).toBe('messaging');
    }
  });

  it('treats social + messaging as billable and integrations as not billable', () => {
    expect(isBillablePlatform('facebook')).toBe(true);
    expect(isBillablePlatform('slack')).toBe(true);
    expect(isBillablePlatform('google_drive')).toBe(false);
    expect(isBillablePlatform('google_calendar')).toBe(false);
  });
});
