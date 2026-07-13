import {
  ConflictEvent,
  ConflictLink,
  ConflictPost,
  eventContentHash,
  resolveConflict,
} from './calendar-conflict';
import { contentHash, postToEventInput } from './calendar-sync.mapper';

// Fixed clock-independent instants: the engine is pure, so absolute times only
// matter relative to each other.
const T0 = new Date('2026-07-13T10:00:00.000Z'); // post.updatedAt
const EARLIER = new Date('2026-07-13T09:00:00.000Z');
const LATER = new Date('2026-07-13T11:00:00.000Z');

const SCHEDULED_AT = new Date('2026-07-20T15:00:00.000Z');
const MOVED_TO = new Date('2026-07-21T09:30:00.000Z');

function link(overrides: Partial<ConflictLink> = {}): ConflictLink {
  return { etag: 'etag-ours', lastPushedHash: 'hash-ours', ...overrides };
}

function post(overrides: Partial<ConflictPost> = {}): ConflictPost {
  return { updatedAt: T0, scheduledAt: SCHEDULED_AT, ...overrides };
}

function event(overrides: Partial<ConflictEvent> = {}): ConflictEvent {
  return {
    deleted: false,
    etag: 'etag-theirs',
    title: 'Some event',
    startsAt: MOVED_TO,
    endsAt: new Date(MOVED_TO.getTime() + 30 * 60 * 1000),
    externalUpdatedAt: LATER,
    ...overrides,
  };
}

describe('resolveConflict — truth table', () => {
  // ---------------------------------------------------------------- 1. deleted
  describe('deleted event', () => {
    it('always wins → apply_external (unschedule the post)', () => {
      expect(
        resolveConflict({
          link: link(),
          event: { deleted: true },
          post: post(),
        }),
      ).toBe('apply_external');
    });

    it('takes priority over the etag echo check', () => {
      expect(
        resolveConflict({
          link: link({ etag: 'same' }),
          event: { deleted: true, etag: 'same' },
          post: post(),
        }),
      ).toBe('apply_external');
    });

    it('takes priority even when the app is the newer writer', () => {
      expect(
        resolveConflict({
          link: link(),
          event: { deleted: true, externalUpdatedAt: EARLIER },
          post: post({ updatedAt: LATER }),
        }),
      ).toBe('apply_external');
    });

    it('never resolves to anything destructive — the only delete-time decision is apply_external (post → draft), never a post delete', () => {
      const decision = resolveConflict({
        link: link(),
        event: { deleted: true },
        post: post(),
      });
      // The decision union has no "delete the post" member by construction; this
      // pins that a tombstone maps to the (non-destructive) unschedule path.
      expect(decision).toBe('apply_external');
      expect(['skip_echo', 'repush_app', 'noop']).not.toContain(decision);
    });
  });

  // ------------------------------------------------------------- 2. etag echo
  describe('etag echo', () => {
    it('skips when the inbound etag is the one we stored', () => {
      expect(
        resolveConflict({
          link: link({ etag: 'etag-ours' }),
          event: event({ etag: 'etag-ours', externalUpdatedAt: LATER }),
          post: post(),
        }),
      ).toBe('skip_echo');
    });

    it('does not skip when the link has no etag', () => {
      expect(
        resolveConflict({
          link: link({ etag: null, lastPushedHash: null }),
          event: event({ etag: 'etag-theirs' }),
          post: post(),
        }),
      ).toBe('apply_external');
    });
  });

  // ------------------------------------------------------------- 3. hash echo
  describe('content-hash echo', () => {
    it('skips when the inbound body hashes to what we last pushed (etag drifted)', () => {
      const pushed = postToEventInput({
        id: 'post-1',
        workspaceId: 'ws-1',
        content: 'Launch day thread 🚀',
        scheduledAt: SCHEDULED_AT,
      });
      const pushedHash = contentHash(pushed);

      const decision = resolveConflict({
        link: link({ etag: 'stale-etag', lastPushedHash: pushedHash }),
        // The provider echoes back exactly what we wrote, with a new etag.
        event: event({
          etag: 'brand-new-etag',
          title: pushed.summary,
          startsAt: pushed.startTime,
          endsAt: pushed.endTime,
          externalUpdatedAt: LATER,
        }),
        post: post(),
      });

      expect(decision).toBe('skip_echo');
    });

    it('does not skip when the body differs from what we pushed', () => {
      expect(
        resolveConflict({
          link: link({ etag: 'stale-etag', lastPushedHash: 'hash-ours' }),
          event: event({ etag: 'new-etag', externalUpdatedAt: LATER }),
          post: post(),
        }),
      ).toBe('apply_external');
    });

    it('cannot hash a timeless event → falls through to the LWW comparison', () => {
      expect(
        eventContentHash({ startsAt: null, endsAt: null, title: 'x' }),
      ).toBeNull();
    });
  });

  // -------------------------------------------------------- 4. external newer
  describe('external is newer (last-write-wins)', () => {
    it('applies the external move → apply_external', () => {
      expect(
        resolveConflict({
          link: link(),
          event: event({ externalUpdatedAt: LATER, startsAt: MOVED_TO }),
          post: post({ updatedAt: T0, scheduledAt: SCHEDULED_AT }),
        }),
      ).toBe('apply_external');
    });

    it('treats a missing post timestamp as "external wins"', () => {
      expect(
        resolveConflict({
          link: link(),
          event: event({ externalUpdatedAt: EARLIER }),
          post: post({ updatedAt: null }),
        }),
      ).toBe('apply_external');
    });
  });

  // ----------------------------------------------------------------- 5. noop
  describe('noop', () => {
    it('external is newer but the event already sits at the post schedule (title-only edit)', () => {
      expect(
        resolveConflict({
          link: link(),
          event: event({
            externalUpdatedAt: LATER,
            startsAt: SCHEDULED_AT,
            title: 'user renamed the event',
          }),
          post: post({ scheduledAt: SCHEDULED_AT }),
        }),
      ).toBe('noop');
    });

    it('external is newer but the event carries no start time', () => {
      expect(
        resolveConflict({
          link: link(),
          event: event({ externalUpdatedAt: LATER, startsAt: null }),
          post: post(),
        }),
      ).toBe('noop');
    });
  });

  // ------------------------------------------------------------- 6. app newer
  describe('app is newer', () => {
    it('re-pushes the app state → repush_app', () => {
      expect(
        resolveConflict({
          link: link(),
          event: event({ externalUpdatedAt: EARLIER }),
          post: post({ updatedAt: LATER }),
        }),
      ).toBe('repush_app');
    });

    it('re-pushes when the provider gave us no last-modified timestamp', () => {
      expect(
        resolveConflict({
          link: link(),
          event: event({ externalUpdatedAt: null }),
          post: post(),
        }),
      ).toBe('repush_app');
    });

    it('an equal timestamp is NOT "newer" → the app still wins', () => {
      expect(
        resolveConflict({
          link: link(),
          event: event({ externalUpdatedAt: T0 }),
          post: post({ updatedAt: T0 }),
        }),
      ).toBe('repush_app');
    });
  });

  // ----------------------------------------------- echo suppression: no loops
  describe('echo suppression closes the loop', () => {
    it('our own repush comes back as skip_echo on the next delta', () => {
      const pushed = postToEventInput({
        id: 'post-1',
        workspaceId: 'ws-1',
        content: 'hello world',
        scheduledAt: SCHEDULED_AT,
      });
      // After a repush the service stamps the link with the provider's new etag
      // + the hash of the body it wrote.
      const stamped = link({
        etag: 'etag-after-our-write',
        lastPushedHash: contentHash(pushed),
      });

      // The delta then hands that very version back to us.
      const echo = event({
        etag: 'etag-after-our-write',
        title: pushed.summary,
        startsAt: pushed.startTime,
        endsAt: pushed.endTime,
        externalUpdatedAt: LATER,
      });

      expect(
        resolveConflict({ link: stamped, event: echo, post: post() }),
      ).toBe('skip_echo');

      // …and even if the provider hands back a DIFFERENT etag, the content hash
      // still recognises our own write (belt-and-braces, no ping-pong).
      expect(
        resolveConflict({
          link: stamped,
          event: { ...echo, etag: 'etag-rewritten-by-provider' },
          post: post(),
        }),
      ).toBe('skip_echo');
    });
  });
});
