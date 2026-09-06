import { ResourceType } from './usage.service';

describe('ResourceType', () => {
  // Post limits are enforced live over `scheduled` rows, but usage_events
  // records a POST resource type so the audit trail can carry the refusal.
  it('includes POST', () => {
    const t: ResourceType = 'POST';
    expect(t).toBe('POST');
  });
});
