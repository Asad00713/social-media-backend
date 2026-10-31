import type { UserRef } from '../dto/contract';

export interface UserRefRow {
  id: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
}

/**
 * A joined `users` row as the contract's `UserRef`. A user who never set a
 * name shows the local part of their email, never an empty label.
 */
export function toUserRef(row: UserRefRow | null): UserRef | null {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name ?? row.email.split('@')[0],
    avatarUrl: row.avatarUrl,
  };
}
