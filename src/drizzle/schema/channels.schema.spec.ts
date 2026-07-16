import { PLATFORM_CONFIG } from './channels.schema';

describe('Threads OAuth scopes', () => {
  it('requests all 6 scopes the features need', () => {
    expect(PLATFORM_CONFIG.threads.oauthScopes).toEqual([
      'threads_basic',
      'threads_content_publish',
      'threads_manage_replies',
      'threads_read_replies',
      'threads_manage_insights',
      'threads_manage_mentions',
    ]);
  });
});

// Google classifies these as RESTRICTED: requesting any of them forces an
// annual CASA security assessment. drive.file is non-sensitive. This test is
// the tripwire for the whole Picker migration — if someone re-adds a broad
// Drive scope to "make listing work again", CASA silently comes back.
const RESTRICTED_DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.metadata',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/drive.photos.readonly',
];

it('google_drive requests only the non-sensitive drive.file scope', () => {
  expect(PLATFORM_CONFIG.google_drive.oauthScopes).toEqual([
    'https://www.googleapis.com/auth/drive.file',
  ]);
});

it('google_drive requests no restricted Drive scope', () => {
  for (const scope of PLATFORM_CONFIG.google_drive.oauthScopes) {
    expect(RESTRICTED_DRIVE_SCOPES).not.toContain(scope);
  }
});
