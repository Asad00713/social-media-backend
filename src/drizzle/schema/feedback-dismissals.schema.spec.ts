import { feedbackDismissals } from './feedback-dismissals.schema';
import { getTableConfig } from 'drizzle-orm/pg-core';

describe('feedback_dismissals schema', () => {
  it('is named feedback_dismissals', () => {
    expect(getTableConfig(feedbackDismissals).name).toBe(
      'feedback_dismissals',
    );
  });

  it('has user_id, type and dismissed_at columns', () => {
    const cols = getTableConfig(feedbackDismissals).columns.map(
      (c) => c.name,
    );
    expect(cols).toEqual(
      expect.arrayContaining(['user_id', 'type', 'dismissed_at']),
    );
  });

  it('has a unique (user_id, type) index — only the newest dismissal matters', () => {
    const idx = getTableConfig(feedbackDismissals).indexes.find(
      (i) => i.config.name === 'feedback_dismissals_user_type_uq',
    );
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(true);
  });
});
