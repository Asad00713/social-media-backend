import type { UsageEntry } from '../dto/contract';
import { usageStatusOfPost, usageStatusOfSlot } from './usage-sql';

describe('usageStatusOfPost', () => {
  it.each<[string, UsageEntry['status']]>([
    ['draft', 'draft'],
    ['scheduled', 'scheduled'],
    ['publishing', 'scheduled'],
    ['published', 'published'],
    ['partially_published', 'published'],
    ['failed', 'failed'],
    ['cancelled', 'draft'],
    ['', 'draft'],
  ])('%p → %p', (status, expected) => {
    expect(usageStatusOfPost(status)).toBe(expected);
  });
});

describe('usageStatusOfSlot', () => {
  it.each<[string, UsageEntry['status']]>([
    ['pending', 'scheduled'],
    ['scheduled', 'scheduled'],
    ['publishing', 'scheduled'],
    ['published', 'published'],
    ['failed', 'failed'],
    ['skipped', 'draft'],
    ['cancelled', 'draft'],
    ['', 'draft'],
  ])('%p → %p', (status, expected) => {
    expect(usageStatusOfSlot(status)).toBe(expected);
  });
});
