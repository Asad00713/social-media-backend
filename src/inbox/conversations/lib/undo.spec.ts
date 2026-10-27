import { undoFor, type PatchState } from './undo';

const L = new Date('2026-10-30T09:00:00.000Z');
const toReply: PatchState = {
  status: 'to_reply',
  laterUntil: null,
  laterUntilReply: false,
  assigneeUserId: null,
};

describe('undoFor', () => {
  it.each([
    ['done from to_reply', { status: 'done' }, toReply, { status: 'to_reply' }],
    [
      'done from later',
      { status: 'done' },
      { ...toReply, status: 'later', laterUntil: L },
      { status: 'later', laterUntil: L.toISOString(), laterUntilReply: false },
    ],
    ['assign', { assigneeUserId: 'u2' }, toReply, { assigneeUserId: null }],
    [
      'status + assignee',
      { status: 'done', assigneeUserId: 'u2' },
      { ...toReply, assigneeUserId: 'u1' },
      { status: 'to_reply', assigneeUserId: 'u1' },
    ],
    [
      'laterPreset is never copied (D18)',
      { status: 'later', laterPreset: 'tomorrow' },
      toReply,
      { status: 'to_reply' },
    ],
    [
      'laterUntil patch undoes via status',
      { laterUntil: '2026-11-01T00:00:00.000Z' },
      { ...toReply, status: 'later', laterUntil: L, laterUntilReply: true },
      { status: 'later', laterUntil: L.toISOString(), laterUntilReply: true },
    ],
  ] as const)('%s', (_n, patch, prev, expected) => {
    expect(undoFor(patch as never, prev as PatchState)).toEqual(expected);
  });
});
