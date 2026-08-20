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

  it('has a unique (user_id, type) index', () => {
    const indexes = getTableConfig(feedback).indexes;
    const idx = indexes.find(
      (i) => i.config.name === 'feedback_user_id_type_idx',
    );
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.columns.map((c: { name: string }) => c.name)).toEqual([
      'user_id',
      'type',
    ]);
  });
});
