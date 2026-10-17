import { BadRequestException } from '@nestjs/common';

export interface DraftCursor {
  /** 1 when the draft is marked ready: ready drafts sort first. */
  ready: 0 | 1;
  /** `floor(extract(epoch from updated_at) * 1000)`, selected from SQL. */
  updatedMs: string;
  id: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MS_RE = /^\d{1,16}$/;

export function encodeDraftCursor(c: DraftCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeDraftCursor(raw: string): DraftCursor {
  const invalid = () => new BadRequestException('Invalid cursor');
  if (!raw || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!parsed || typeof parsed !== 'object') throw invalid();
  const { ready, updatedMs, id } = parsed as Record<string, unknown>;
  if (
    (ready !== 0 && ready !== 1) ||
    typeof updatedMs !== 'string' ||
    !MS_RE.test(updatedMs) ||
    typeof id !== 'string' ||
    !UUID_RE.test(id)
  ) {
    throw invalid();
  }
  return { ready, updatedMs, id };
}
