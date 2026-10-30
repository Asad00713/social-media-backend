import {
  replyWindowClosesAt,
  replyWindowState,
  sendLaterCap,
} from './reply-window';

const INBOUND = new Date('2026-10-26T10:00:00Z');
const CLOSES = new Date('2026-10-27T10:00:00Z');

describe('replyWindowClosesAt', () => {
  it.each([
    ['instagram', 'dm', INBOUND, CLOSES],
    ['facebook', 'comment_thread', INBOUND, null],
    ['youtube', 'dm', INBOUND, null],
    ['whatsapp', 'dm', null, null],
  ] as const)('%s %s', (platform, kind, last, expected) => {
    expect(replyWindowClosesAt(platform, kind, last)).toEqual(expected);
  });
});

describe('replyWindowState', () => {
  it.each([
    [null, '2026-10-27T08:59:59Z', 'none'],
    [CLOSES, '2026-10-27T08:59:59Z', 'open'],
    [CLOSES, '2026-10-27T09:00:00Z', 'open'],
    [CLOSES, '2026-10-27T09:00:01Z', 'closing'],
    [CLOSES, '2026-10-27T10:00:00Z', 'closed'],
  ])('closes %s at %s -> %s', (closes, now, expected) => {
    expect(replyWindowState(closes, new Date(now))).toBe(expected);
  });
});

describe('sendLaterCap', () => {
  it.each([
    [
      CLOSES,
      '2026-10-27T08:00:00Z',
      { latestSendLaterAt: '2026-10-27T09:59:00.000Z', canSendLater: true },
    ],
    [
      CLOSES,
      '2026-10-27T09:30:00Z',
      { latestSendLaterAt: '2026-10-27T09:59:00.000Z', canSendLater: false },
    ],
    [
      null,
      '2026-10-27T09:30:00Z',
      { latestSendLaterAt: null, canSendLater: true },
    ],
    [
      CLOSES,
      '2026-10-27T10:00:00Z',
      { latestSendLaterAt: '2026-10-27T09:59:00.000Z', canSendLater: false },
    ],
    [
      CLOSES,
      '2026-10-27T11:00:00Z',
      { latestSendLaterAt: '2026-10-27T09:59:00.000Z', canSendLater: false },
    ],
  ])('closes %s at %s', (closes, now, expected) => {
    expect(sendLaterCap(closes, new Date(now))).toEqual(expected);
  });
});
