import { inArray } from 'drizzle-orm';
import type { DbType } from '../../drizzle/db';
import { users } from '../../drizzle/schema/users.schema';
import type { PersonRef } from './channel-health';

/** The display name rule the Planner uses: name, else the email's local part. */
export function displayNameOf(u: {
  name: string | null;
  email: string;
}): string {
  return u.name?.trim() || u.email.split('@')[0];
}

/**
 * One `users` query for every id given (nulls and repeats ignored). An id
 * with no user - deleted, or never existed - is simply absent from the map.
 */
export async function loadPeople(
  db: Pick<DbType, 'select'>,
  ids: Array<string | null | undefined>,
): Promise<Map<string, PersonRef>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, wanted));
  return new Map(rows.map((u) => [u.id, { id: u.id, name: displayNameOf(u) }]));
}

/** `{id, name}` for an id, or null when there is no id or no such user. */
export function personOf(
  people: Map<string, PersonRef>,
  id: string | null | undefined,
): PersonRef | null {
  return id ? (people.get(id) ?? null) : null;
}
