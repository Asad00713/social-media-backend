import { createHash } from 'node:crypto';
import { refusal } from './refusal';

/**
 * Draft approvals ("Needs approval" in the composer's Post section).
 *
 * The request lives on the draft itself, in `posts.metadata.approval`, so no
 * migration is needed. The `ready_at` / `ready_by_id` columns were looked at
 * and NOT reused: "ready" is a flag anyone may set on their own draft and a
 * trigger clears it when the post leaves 'draft', while an approval must be
 * granted by someone else and must survive into 'scheduled'.
 *
 * An approval covers the content that was approved. Its fingerprint is kept
 * with the grant; any later change to the caption, media, per-channel content
 * or channel list voids it, and the post needs approving again.
 */

/** The capability an approver needs (ADMIN and OWNER today). */
export const APPROVE_CAPABILITY = 'posts:approve' as const;

/**
 * Decision: whoever asked for the approval may not grant it, even when their
 * role could. "Sara approves it first" (Figma 4263:15046) is someone else.
 * Flip to true to let an admin approve their own request.
 */
export const ALLOW_SELF_APPROVAL = false;

export interface DraftApproval {
  required: true;
  requestedById: string;
  requestedAt: string;
  approvedById: string | null;
  approvedAt: string | null;
  /** Fingerprint of the content the grant covers; null until approved. */
  approvedFingerprint: string | null;
}

/** The row-shaped content an approval covers. */
export interface ApprovableContent {
  content: string | null | undefined;
  mediaItems: unknown;
  platformContent: unknown;
  targets:
    | ReadonlyArray<{ channelId?: string | number | null }>
    | null
    | undefined;
}

export type ApprovalState = 'none' | 'pending' | 'approved';

/** The approval stored on a post's metadata, or null when none is required. */
export function readApproval(metadata: unknown): DraftApproval | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as Record<string, unknown>).approval;
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (a.required !== true || typeof a.requestedById !== 'string') return null;
  return {
    required: true,
    requestedById: a.requestedById,
    requestedAt: typeof a.requestedAt === 'string' ? a.requestedAt : '',
    approvedById: typeof a.approvedById === 'string' ? a.approvedById : null,
    approvedAt: typeof a.approvedAt === 'string' ? a.approvedAt : null,
    approvedFingerprint:
      typeof a.approvedFingerprint === 'string' ? a.approvedFingerprint : null,
  };
}

export function newApprovalRequest(
  userId: string,
  now: Date = new Date(),
): DraftApproval {
  return {
    required: true,
    requestedById: userId,
    requestedAt: now.toISOString(),
    approvedById: null,
    approvedAt: null,
    approvedFingerprint: null,
  };
}

/**
 * JSON with object keys sorted, for values that came out of JSON (a request
 * body or a jsonb column). jsonb does not keep key order, so a plain
 * JSON.stringify of the stored copy and of the same content sent again would
 * differ. Hand-written rather than a package: it only ever sees parsed JSON,
 * which keeps it to the four cases below.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/**
 * What an approval covers: the caption, the media, every channel's own
 * content and settings, and which channels it goes to. The per-channel
 * delivery state on `targets` is left out on purpose — publishing changes it.
 */
export function contentFingerprint(c: ApprovableContent): string {
  const channels = [
    ...new Set((c.targets ?? []).map((t) => String(t?.channelId ?? ''))),
  ].sort();
  const body = canonicalJson({
    text: c.content ?? '',
    media: c.mediaItems ?? [],
    per: c.platformContent ?? {},
    channels,
  });
  return createHash('sha256').update(body).digest('hex');
}

export function approvalState(
  approval: DraftApproval | null,
  fingerprint: string,
): ApprovalState {
  if (!approval) return 'none';
  return approval.approvedAt && approval.approvedFingerprint === fingerprint
    ? 'approved'
    : 'pending';
}

/**
 * Refuses to let a post that needs approval go out without one that covers
 * exactly this content. Call before any write, job or publisher call.
 */
export function assertApprovedFor(
  metadata: unknown,
  content: ApprovableContent,
): void {
  const approval = readApproval(metadata);
  if (!approval) return;
  if (!approval.approvedAt) {
    throw refusal(
      'This post needs approval before it can be scheduled or published.',
      'APPROVAL_REQUIRED',
    );
  }
  if (approval.approvedFingerprint !== contentFingerprint(content)) {
    throw refusal(
      'This post changed after it was approved. It needs approving again before it can be scheduled or published.',
      'APPROVAL_STALE',
    );
  }
}

/**
 * The `approval` key to write back when a post's content is rewritten
 * wholesale (the composer replaces `metadata` on every save). The request is
 * kept; a grant that no longer matches the new content is withdrawn.
 * Returns {} when the post needs no approval.
 */
export function carryApproval(
  existingMetadata: unknown,
  next: ApprovableContent,
): { approval?: DraftApproval } {
  const approval = readApproval(existingMetadata);
  if (!approval) return {};
  if (
    approval.approvedAt &&
    approval.approvedFingerprint !== contentFingerprint(next)
  ) {
    return {
      approval: {
        ...approval,
        approvedById: null,
        approvedAt: null,
        approvedFingerprint: null,
      },
    };
  }
  return { approval };
}

/** A metadata object from a client, with any `approval` it tried to set removed. */
export function withoutApproval<T extends Record<string, unknown>>(
  metadata: T | null | undefined,
): Omit<T, 'approval'> | undefined {
  if (!metadata) return undefined;
  const rest: Record<string, unknown> = { ...metadata };
  delete rest.approval;
  return rest as Omit<T, 'approval'>;
}
