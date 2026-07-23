import { isContentRedacted } from './inbox.service';

// InboxService itself takes several injected collaborators (AnalyticsEventEmitter,
// InboxDispatcher, ChannelService, FacebookService, InstagramService, a BullMQ
// Queue) and reads `db` as a module-level singleton, which makes instantiating
// the full service for a one-line computation impractical (see
// `inbox.service.hide.spec.ts` for the mocking ceremony that requires).
// `isContentRedacted` is exported specifically so this can be unit-tested as a
// pure function instead.
describe('isContentRedacted', () => {
  it('reports true for a YouTube row whose text was nulled by the retention job', () => {
    expect(
      isContentRedacted({ platform: 'youtube', text: null }),
    ).toBe(true);
  });

  it('reports false for a YouTube row with real text', () => {
    expect(
      isContentRedacted({ platform: 'youtube', text: 'nice video!' }),
    ).toBe(false);
  });

  // Discriminating case: a naive `!item.text` check would wrongly flag this
  // as redacted. Only a raw `null` (the retention wipe) counts — a genuinely
  // empty string must not be reported as redacted.
  it('reports false for a YouTube row with genuinely empty-string text', () => {
    expect(isContentRedacted({ platform: 'youtube', text: '' })).toBe(false);
  });

  it('reports false for a non-YouTube row with null text, since the retention job never touches other platforms', () => {
    expect(
      isContentRedacted({ platform: 'facebook', text: null }),
    ).toBe(false);
  });
});
