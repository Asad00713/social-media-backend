import {
  evergreenCategories,
  evergreenPosts,
  evergreenOccurrences,
  EVERGREEN_POST_STATUSES,
} from './evergreen.schema';
import { getTableConfig } from 'drizzle-orm/pg-core';

describe('evergreen schema', () => {
  it('defines the three evergreen tables with correct names', () => {
    expect(getTableConfig(evergreenCategories).name).toBe(
      'campaign_evergreen_categories',
    );
    expect(getTableConfig(evergreenPosts).name).toBe(
      'campaign_evergreen_posts',
    );
    expect(getTableConfig(evergreenOccurrences).name).toBe(
      'campaign_evergreen_occurrences',
    );
  });

  it('categories table has a unique (campaign_id, name) index', () => {
    const idx = getTableConfig(evergreenCategories).indexes.map(
      (i) => i.config.name,
    );
    expect(idx).toContain('evergreen_categories_campaign_name_uq');
  });

  it('exports the post status enum', () => {
    expect(EVERGREEN_POST_STATUSES).toEqual(['active', 'paused', 'retired']);
  });

  it('posts table has category_id and campaign_id columns', () => {
    const cols = getTableConfig(evergreenPosts).columns.map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'category_id',
        'campaign_id',
        'content',
        'variations',
        'recycle_policy',
        'performance_score',
        'is_stale',
        'status',
      ]),
    );
  });
});
