import { users } from '../../drizzle/schema/users.schema';
import type { UserRef } from '../dto/contract';

export interface UserRefRow {
  id: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
}

/**
 * The `users` columns a `UserRef` is built from, for a select that
 * left-joins `users` once. A missing user comes back as a null object.
 */
export const USER_REF_COLUMNS = {
  id: users.id,
  name: users.name,
  email: users.email,
  avatarUrl: users.avatarUrl,
};

/**
 * A joined `users` row as the contract's `UserRef`. A user with no name (null
 * or empty) shows the local part of their email, never an empty label.
 */
export function toUserRef(row: UserRefRow | null): UserRef | null {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name || row.email.split('@')[0],
    avatarUrl: row.avatarUrl,
  };
}
