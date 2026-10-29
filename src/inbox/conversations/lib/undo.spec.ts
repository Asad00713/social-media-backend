import { undoFor, type PatchConversationBody, type PatchState } from './undo';

const L = new Date('2026-10-30T09:00:00.000Z');
const toReply: PatchState = {
  status: 'to_reply',
  laterUntil: null,
  laterUntilReply: false,
  assigneeUserId: null,
};
const later = (o: Partial<PatchState> = {}): PatchState => ({
  ...toReply,
  status: 'later',
  laterUntil: L,
  ...o,
});

type Row = [string, PatchConversationBody, PatchState, PatchConversationBody];

describe('undoFor', () => {
  it.each<Row>([
    ['done from to_reply', { status: 'done' }, toReply, { status: 'to_reply' }],
    [
      'done from later',
      { status: 'done' },
      later(),
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
      'laterUntil alone is not a status change',
      { laterUntil: '2026-11-01T00:00:00.000Z' },
      later({ laterUntilReply: true }),
      {},
    ],
    [
      'laterPreset alone is not a status change',
      { laterPreset: 'tomorrow' },
      later(),
      {},
    ],
    [
      'laterUntilReply alone is not a status change',
      { laterUntilReply: true },
      later(),
      {},
    ],
    [
      'laterUntilReply is emitted only when prev was later',
      { status: 'later', laterUntilReply: true },
      toReply,
      { status: 'to_reply' },
    ],
    [
      'later prev with no time keeps laterUntil null',
      { status: 'done' },
      later({ laterUntil: null, laterUntilReply: true }),
      { status: 'later', laterUntil: null, laterUntilReply: true },
    ],
    [
      'unrelated keys are not undone',
      { assigneeUserId: 'u2' },
      later(),
      { assigneeUserId: null },
    ],
  ])('%s', (_name, patch, prev, expected) => {
    expect(undoFor(patch, prev)).toEqual(expected);
  });
});
