import type { Platform } from '../dto/contract';
import {
  commentActions,
  DISALLOWED_FALLBACK,
  type CommentActionInput,
} from './comment-actions';

const NOW = new Date('2026-03-10T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function input(over: Partial<CommentActionInput> = {}): CommentActionInput {
  return {
    platform: 'facebook',
    kind: 'comment_thread',
    fromMe: false,
    deleted: false,
    createdAt: new Date(NOW.getTime() - HOUR),
    privateReplySentAt: null,
    canReply: true,
    accountLabel: 'daybreak.coffee',
    ...over,
  };
}

const YES = { allowed: true };
const NO = { allowed: false };

describe('commentActions: platform x action matrix (inbound, recent, member)', () => {
  type Action = 'like' | 'hide' | 'delete' | 'privateReply';
  const rows: [Platform, Action, object][] = [
    ['facebook', 'like', YES],
    ['facebook', 'hide', YES],
    ['facebook', 'delete', YES],
    ['facebook', 'privateReply', YES],
    [
      'instagram',
      'like',
      { allowed: false, reason: "Instagram doesn't let apps like comments" },
    ],
    ['instagram', 'hide', YES],
    ['instagram', 'delete', YES],
    ['instagram', 'privateReply', YES],
    [
      'threads',
      'like',
      { allowed: false, reason: "Threads doesn't let apps like replies" },
    ],
    ['threads', 'hide', YES],
    ['threads', 'delete', NO],
    ['threads', 'privateReply', NO],
    [
      'youtube',
      'like',
      { allowed: false, reason: "YouTube doesn't let apps like comments" },
    ],
    ['youtube', 'hide', { allowed: false, reason: "YouTube doesn't allow it" }],
    ['youtube', 'delete', YES],
    ['youtube', 'privateReply', NO],
    ['bluesky', 'like', YES],
    ['bluesky', 'hide', YES],
    ['bluesky', 'delete', NO],
    ['bluesky', 'privateReply', NO],
    ['mastodon', 'like', YES],
    [
      'mastodon',
      'hide',
      { allowed: false, reason: "Mastodon doesn't let you hide replies" },
    ],
    ['mastodon', 'delete', NO],
    ['mastodon', 'privateReply', NO],
  ];

  it.each(rows)('%s %s', (platform, action, expected) => {
    expect(commentActions(input({ platform }), NOW)[action]).toStrictEqual(
      expected,
    );
  });

  it.each([
    'facebook',
    'instagram',
    'threads',
    'youtube',
    'bluesky',
    'mastodon',
  ] as Platform[])('%s reply is allowed', (platform) => {
    expect(commentActions(input({ platform }), NOW).reply).toStrictEqual(YES);
  });
});

describe('commentActions: overrides', () => {
  it('Guest: like carries the member-only reason, everything else is hidden', () => {
    expect(commentActions(input({ canReply: false }), NOW)).toStrictEqual({
      reply: NO,
      like: {
        allowed: false,
        reason: 'Only members can like as daybreak.coffee',
      },
      hide: NO,
      delete: NO,
      privateReply: NO,
    });
  });

  it('deleted: all five actions are plain not-allowed', () => {
    expect(
      commentActions(input({ deleted: true, platform: 'instagram' }), NOW),
    ).toStrictEqual({
      reply: NO,
      like: NO,
      hide: NO,
      delete: NO,
      privateReply: NO,
    });
  });

  it('deleted beats the Guest rule', () => {
    expect(
      commentActions(input({ deleted: true, canReply: false }), NOW).like,
    ).toStrictEqual(NO);
  });

  it('our own Facebook comment: no hide, no private reply, but delete', () => {
    const a = commentActions(input({ fromMe: true }), NOW);
    expect(a.hide).toStrictEqual(NO);
    expect(a.privateReply).toStrictEqual(NO);
    expect(a.delete).toStrictEqual(YES);
  });

  it('our own YouTube comment: hide has no reason (own-comment override wins)', () => {
    expect(
      commentActions(input({ platform: 'youtube', fromMe: true }), NOW).hide,
    ).toStrictEqual(NO);
  });

  it('own comment on Bluesky/Mastodon can be deleted; Threads cannot', () => {
    expect(
      commentActions(input({ platform: 'bluesky', fromMe: true }), NOW).delete,
    ).toStrictEqual(YES);
    expect(
      commentActions(input({ platform: 'mastodon', fromMe: true }), NOW).delete,
    ).toStrictEqual(YES);
    expect(
      commentActions(input({ platform: 'threads', fromMe: true }), NOW).delete,
    ).toStrictEqual(NO);
  });

  it('hide on a mention is not allowed', () => {
    expect(
      commentActions(input({ kind: 'mention', platform: 'threads' }), NOW).hide,
    ).toStrictEqual(NO);
  });

  it('private reply expires after 7 days', () => {
    const old = commentActions(
      input({ createdAt: new Date(NOW.getTime() - 7 * DAY - MINUTE) }),
      NOW,
    );
    expect(old.privateReply).toStrictEqual(NO);
    const fresh = commentActions(
      input({ createdAt: new Date(NOW.getTime() - 6 * DAY - 23 * HOUR) }),
      NOW,
    );
    expect(fresh.privateReply).toStrictEqual(YES);
  });

  it('private reply is one per comment', () => {
    expect(
      commentActions(input({ privateReplySentAt: new Date(NOW) }), NOW)
        .privateReply,
    ).toStrictEqual(NO);
  });

  it('exposes the fallback body for reason-less refusals', () => {
    expect(DISALLOWED_FALLBACK).toBe("This isn't available for this comment");
  });
});
