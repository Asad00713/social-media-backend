import { feedback, FEEDBACK_TYPE } from './feedback.schema';
import { getTableConfig } from 'drizzle-orm/pg-core';

describe('feedback schema', () => {
  it('exports the feedback type enum with exactly app and maestro', () => {
    expect(FEEDBACK_TYPE).toEqual(['app', 'maestro']);
  });

  it('has a type column on the feedback table', () => {
    const cols = getTableConfig(feedback).columns.map((c) => c.name);
    expect(cols).toContain('type');
  });

  it('defaults the type column to app and makes it not null', () => {
    const typeCol = getTableConfig(feedback).columns.find(
      (c) => c.name === 'type',
    );
    expect(typeCol?.notNull).toBe(true);
    expect(typeCol?.default).toBe('app');
  });

  it('has a NON-unique (user_id, type, created_at) index for latest-row lookups', () => {
    const indexes = getTableConfig(feedback).indexes;
    const idx = indexes.find(
      (i) => i.config.name === 'feedback_user_id_type_idx',
    );
    expect(idx).toBeDefined();
    // Recurring feedback: a user may have many reviews per type over time,
    // so uniqueness here would be the bug, not the guard.
    expect(idx?.config.unique).toBe(false);
  });
});
