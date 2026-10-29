import type { ConversationKind } from './thread-key';

export type ConversationStatus = 'to_reply' | 'later' | 'done';
export type DoneVia = 'reply' | 'manual' | 'platform';

export interface LifecycleState {
  status: ConversationStatus;
  laterUntil: Date | null;
  laterUntilReply: boolean;
  doneByUserId: string | null;
  doneAt: Date | null;
  doneVia: DoneVia | null;
  assigneeUserId: string | null;
  assignedByUserId: string | null;
  assignedAt: Date | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
}

export interface ThreadFacts {
  kind: ConversationKind;
  lastInboundAt: Date | null;
  /** Any from_me row. */
  lastOutboundAt: Date | null;
  /** from_me rows with no authored_by_user_id (R5). */
  lastPlatformOutboundAt: Date | null;
  /** authored_by_user_id of the latest from_me row; null when unauthored or absent. */
  lastOutboundAuthorId?: string | null;
  /** Inbound, replied_at IS NULL, not deleted, not hidden. */
  unansweredInbound: number;
  /** Inbound with status IN ('unread', 'needs_reply'). */
  openLegacyInbound: number;
}

export type SyncIntent =
  | { kind: 'refresh' }
  | { kind: 'outbound'; userId: string; markDone: boolean; at: Date }
  | {
      kind: 'manual';
      userId: string;
      status?: ConversationStatus;
      laterUntil?: Date | null;
      laterUntilReply?: boolean;
      assignee?: { userId: string | null };
    }
  | { kind: 'legacy_status'; userId: string }
  | { kind: 'wake'; laterUntil: Date };

export interface LifecycleResult {
  next: LifecycleState;
  markedDone: boolean;
  reopened: boolean;
}

const CLEAR_DONE = {
  doneByUserId: null,
  doneAt: null,
  doneVia: null,
} as const;
const CLEAR_LATER = { laterUntil: null, laterUntilReply: false } as const;

function initialState(facts: ThreadFacts, intent: SyncIntent): LifecycleState {
  const base: LifecycleState = {
    status: 'to_reply',
    laterUntil: null,
    laterUntilReply: false,
    doneByUserId: null,
    doneAt: null,
    doneVia: null,
    assigneeUserId: null,
    assignedByUserId: null,
    assignedAt: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  };
  if (facts.lastInboundAt !== null) return base;
  if (intent.kind === 'outbound') {
    return {
      ...base,
      status: 'done',
      doneVia: 'reply',
      doneByUserId: intent.userId,
      doneAt: intent.at,
    };
  }
  // A thread with no visible inbound that a teammate started: Done by that
  // author via 'reply', the same as the 0052 backfill lands it.
  if (facts.lastOutboundAuthorId) {
    return {
      ...base,
      status: 'done',
      doneVia: 'reply',
      doneByUserId: facts.lastOutboundAuthorId,
      doneAt: facts.lastOutboundAt,
    };
  }
  return {
    ...base,
    status: 'done',
    doneVia: 'platform',
    doneAt: facts.lastOutboundAt,
  };
}

/**
 * Pure transition of a conversation's lifecycle. The order of the numbered
 * steps is load-bearing.
 */
export function applyLifecycle(
  prev: LifecycleState | null,
  facts: ThreadFacts,
  intent: SyncIntent,
  now: Date,
): LifecycleResult {
  // 0. base
  const next: LifecycleState = { ...(prev ?? initialState(facts, intent)) };
  let markedDone = false;
  let reopened = false;

  // 1. reopen on a newer inbound
  if (
    prev &&
    facts.lastInboundAt &&
    (!prev.lastInboundAt || facts.lastInboundAt > prev.lastInboundAt)
  ) {
    if (next.status === 'done') {
      Object.assign(next, { status: 'to_reply' }, CLEAR_DONE);
      reopened = true;
    } else if (next.status === 'later' && next.laterUntilReply) {
      Object.assign(next, { status: 'to_reply' }, CLEAR_LATER);
      reopened = true;
    }
  }

  // 2. platform reply (R5)
  if (
    facts.lastPlatformOutboundAt &&
    (!prev?.lastOutboundAt ||
      facts.lastPlatformOutboundAt > prev.lastOutboundAt) &&
    facts.unansweredInbound === 0 &&
    next.status !== 'done'
  ) {
    Object.assign(next, {
      status: 'done',
      doneVia: 'platform',
      doneByUserId: null,
      doneAt: facts.lastPlatformOutboundAt,
    });
  }

  switch (intent.kind) {
    case 'outbound': {
      if (
        intent.markDone &&
        (!facts.lastInboundAt || facts.lastInboundAt <= intent.at) &&
        (facts.kind !== 'comment_thread' || facts.unansweredInbound === 0) // R2
      ) {
        Object.assign(next, {
          status: 'done',
          doneVia: 'reply',
          doneByUserId: intent.userId,
          doneAt: intent.at,
        });
        markedDone = true;
      } else if (
        !intent.markDone &&
        next.status === 'done' &&
        next.doneVia === 'platform' &&
        next.doneAt &&
        (!facts.lastPlatformOutboundAt ||
          facts.lastPlatformOutboundAt < next.doneAt)
      ) {
        // The "platform reply" that closed it was the echo of this keep-open
        // send; the send path has since stamped its author.
        Object.assign(next, { status: 'to_reply' }, CLEAR_DONE);
      }
      break;
    }
    case 'manual': {
      if (intent.status === 'done') {
        Object.assign(next, {
          status: 'done',
          doneVia: 'manual',
          doneByUserId: intent.userId,
          doneAt: now,
        });
      } else if (intent.status === 'to_reply') {
        Object.assign(next, { status: 'to_reply' }, CLEAR_DONE, CLEAR_LATER);
      } else if (intent.status === 'later') {
        Object.assign(next, {
          status: 'later',
          laterUntil: intent.laterUntil ?? null,
          laterUntilReply: intent.laterUntilReply ?? false,
          ...CLEAR_DONE,
        });
      }
      if (intent.assignee) {
        const to = intent.assignee.userId;
        Object.assign(
          next,
          to === null
            ? { assigneeUserId: null, assignedByUserId: null, assignedAt: null }
            : {
                assigneeUserId: to,
                assignedByUserId: intent.userId,
                assignedAt: now,
              },
        );
      }
      break;
    }
    case 'legacy_status': {
      if (facts.openLegacyInbound === 0) {
        if (next.status !== 'done') {
          Object.assign(next, {
            status: 'done',
            doneVia: 'manual',
            doneByUserId: intent.userId,
            doneAt: now,
          });
        }
      } else {
        Object.assign(next, { status: 'to_reply' }, CLEAR_DONE);
      }
      break;
    }
    case 'wake': {
      if (
        next.status === 'later' &&
        next.laterUntil?.getTime() === intent.laterUntil.getTime()
      ) {
        Object.assign(next, { status: 'to_reply' }, CLEAR_LATER);
      }
      break;
    }
    case 'refresh':
      break;
  }

  // 7. facts win for the denormalised timestamps
  next.lastInboundAt = facts.lastInboundAt;
  next.lastOutboundAt = facts.lastOutboundAt;
  return { next, markedDone, reopened };
}
