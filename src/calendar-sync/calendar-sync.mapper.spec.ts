import {
  postToEventInput,
  contentHash,
  PostForMapping,
} from './calendar-sync.mapper';
import {
  SCHEDURA_POST_ID_PROP,
  SCHEDURA_WORKSPACE_ID_PROP,
} from './calendar-sync.constants';

const basePost: PostForMapping = {
  id: 'post-uuid-1',
  workspaceId: 'ws-uuid-1',
  content: 'Launch day! 🎉 Check out our new feature.',
  scheduledAt: new Date('2026-08-01T10:00:00.000Z'),
};

describe('calendar-sync.mapper', () => {
  describe('postToEventInput', () => {
    it('tags the event with both ownership private props', () => {
      const input = postToEventInput(basePost);
      expect(input.privateProps[SCHEDURA_POST_ID_PROP]).toBe('post-uuid-1');
      expect(input.privateProps[SCHEDURA_WORKSPACE_ID_PROP]).toBe('ws-uuid-1');
    });

    it('maps scheduledAt to start and defaults end to start + 30min', () => {
      const input = postToEventInput(basePost);
      expect(input.startTime.toISOString()).toBe('2026-08-01T10:00:00.000Z');
      expect(input.endTime.toISOString()).toBe('2026-08-01T10:30:00.000Z');
    });

    it('derives summary from content', () => {
      const input = postToEventInput(basePost);
      expect(input.summary).toBe('Launch day! 🎉 Check out our new feature.');
    });

    it('truncates long content to <= 80 chars with an ellipsis', () => {
      const long = 'x'.repeat(200);
      const input = postToEventInput({ ...basePost, content: long });
      expect(input.summary.length).toBeLessThanOrEqual(80);
      expect(input.summary.endsWith('…')).toBe(true);
    });

    it('falls back to a placeholder summary for empty content', () => {
      const input = postToEventInput({ ...basePost, content: null });
      expect(input.summary).toBe('(untitled post)');
    });

    it('throws when the post has no scheduledAt', () => {
      expect(() =>
        postToEventInput({ ...basePost, scheduledAt: null }),
      ).toThrow(/scheduledAt/);
    });
  });

  describe('contentHash', () => {
    it('is stable for identical input', () => {
      const input = postToEventInput(basePost);
      const a = contentHash(input);
      const b = contentHash(input);
      expect(a).toBe(b);
    });

    it('produces a short hex digest', () => {
      const hash = contentHash(postToEventInput(basePost));
      expect(hash).toMatch(/^[0-9a-f]{32}$/);
    });

    it('changes when summary changes', () => {
      const input = postToEventInput(basePost);
      const changed = { ...input, summary: 'Different title' };
      expect(contentHash(input)).not.toBe(contentHash(changed));
    });

    it('changes when start time changes', () => {
      const input = postToEventInput(basePost);
      const changed = {
        ...input,
        startTime: new Date('2026-08-01T11:00:00.000Z'),
      };
      expect(contentHash(input)).not.toBe(contentHash(changed));
    });
  });
});
