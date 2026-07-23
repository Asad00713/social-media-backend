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

// The compliance audit requires a per-scope justification explaining why
// nothing narrower suffices. `auth/youtube` ("Manage your YouTube account")
// has no such justification: every call we made under it also accepts
// youtube.force-ssl, which we hold anyway for comment writes. Dropped
// 2026-07-18. This is the tripwire — re-adding it to "fix" a permissions error
// puts back a consent line we cannot defend, and the real cause of such an
// error is almost always a missing force-ssl grant on an older token.
describe('YouTube OAuth scopes', () => {
  it('requests exactly the three scopes the shipped features need', () => {
    expect(PLATFORM_CONFIG.youtube.oauthScopes).toEqual([
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/yt-analytics.readonly',
      'https://www.googleapis.com/auth/youtube.force-ssl',
    ]);
  });

  it('does not request the broad account-management scope', () => {
    expect(PLATFORM_CONFIG.youtube.oauthScopes).not.toContain(
      'https://www.googleapis.com/auth/youtube',
    );
  });

  // Comment replies are the inbox's whole purpose and force-ssl is the only
  // scope that permits them — dropping it would silently break replying.
  it('keeps force-ssl, without which the inbox cannot reply', () => {
    expect(PLATFORM_CONFIG.youtube.oauthScopes).toContain(
      'https://www.googleapis.com/auth/youtube.force-ssl',
    );
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

describe('Google Drive OAuth scopes', () => {
  it('requests only the non-sensitive drive.file scope', () => {
    expect(PLATFORM_CONFIG.google_drive.oauthScopes).toEqual([
      'https://www.googleapis.com/auth/drive.file',
    ]);
  });

  // Deliberately independent of the test above: if someone widens the expected
  // array there to admit a second scope, this still fails when that scope is a
  // known-restricted one.
  it('requests no restricted Drive scope', () => {
    for (const scope of PLATFORM_CONFIG.google_drive.oauthScopes) {
      expect(RESTRICTED_DRIVE_SCOPES).not.toContain(scope);
    }
  });
});
