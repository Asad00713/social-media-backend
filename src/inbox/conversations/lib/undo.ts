import type { ConversationStatus } from './lifecycle';
import type { LaterPreset } from './later-presets';

/** Contract interface; re-exported by Task 6's contract.ts. */
export interface PatchConversationBody {
  status?: ConversationStatus;
  laterUntil?: string | null;
  laterUntilReply?: boolean;
  laterPreset?: LaterPreset;
  assigneeUserId?: string | null;
}

export interface PatchState {
  status: ConversationStatus;
  laterUntil: Date | null;
  laterUntilReply: boolean;
  assigneeUserId: string | null;
}

/**
 * The patch that restores `prev`. `laterPreset` is never copied (D18); a
 * status / laterUntil / laterPreset change is undone through `status` plus,
 * when the thread was in Later, its stored laterUntil / laterUntilReply.
 */
export function undoFor(
  patch: PatchConversationBody,
  prev: PatchState,
): PatchConversationBody {
  const undo: PatchConversationBody = {};
  const touchesStatus =
    patch.status !== undefined ||
    patch.laterUntil !== undefined ||
    patch.laterPreset !== undefined;
  if (touchesStatus) {
    undo.status = prev.status;
    if (prev.status === 'later') {
      undo.laterUntil = prev.laterUntil ? prev.laterUntil.toISOString() : null;
      undo.laterUntilReply = prev.laterUntilReply;
    }
  }
  if (
    patch.laterUntilReply !== undefined &&
    undo.laterUntilReply === undefined
  ) {
    undo.laterUntilReply = prev.laterUntilReply;
  }
  if (patch.assigneeUserId !== undefined) {
    undo.assigneeUserId = prev.assigneeUserId;
  }
  return undo;
}
