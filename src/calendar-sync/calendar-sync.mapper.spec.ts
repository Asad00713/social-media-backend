import {
  postToEventInput,
  messageToEventInput,
  contentHash,
  MessageForMapping,
  PostForMapping,
} from './calendar-sync.mapper';
import {
  SCHEDURA_MESSAGE_ID_PROP,
  SCHEDURA_POST_ID_PROP,
  SCHEDURA_WORKSPACE_ID_PROP,
} from './calendar-sync.constants';

const basePost: PostForMapping = {
  id: 'post-uuid-1',
  workspaceId: 'ws-uuid-1',
  content: 'Launch day! 🎉 Check out our new feature.',
  scheduledAt: new Date('2026-08-01T10:00:00.000Z'),
};

const baseMessage: MessageForMapping = {
  id: 'msg-uuid-1',
  workspaceId: 'ws-uuid-1',
  text: 'Thanks for the kind words!',
  targetLabel: '@alex',
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

    it('uses fallbackTitle when content is empty (e.g. YouTube title-only post)', () => {
      const input = postToEventInput({
        ...basePost,
        content: null,
        fallbackTitle: 'My YouTube video title',
      });
      expect(input.summary).toBe('My YouTube video title');
    });

    it('prefers content over fallbackTitle when both are present', () => {
      const input = postToEventInput({
        ...basePost,
        content: 'Caption wins',
        fallbackTitle: 'Ignored title',
      });
      expect(input.summary).toBe('Caption wins');
    });

    it('throws when the post has no scheduledAt', () => {
      expect(() =>
        postToEventInput({ ...basePost, scheduledAt: null }),
      ).toThrow(/scheduledAt/);
    });
  });

  describe('messageToEventInput', () => {
    it('tags the event with the MESSAGE id prop, never the post id prop', () => {
      const input = messageToEventInput(baseMessage);
      expect(input.privateProps[SCHEDURA_MESSAGE_ID_PROP]).toBe('msg-uuid-1');
      expect(input.privateProps[SCHEDURA_WORKSPACE_ID_PROP]).toBe('ws-uuid-1');
      // Backward compatibility: post events keep `schedura_post_id` to
      // themselves — a message event must NEVER carry it.
      expect(input.privateProps[SCHEDURA_POST_ID_PROP]).toBeUndefined();
    });

    it('maps scheduledAt to start and defaults end to start + 30min', () => {
      const input = messageToEventInput(baseMessage);
      expect(input.startTime.toISOString()).toBe('2026-08-01T10:00:00.000Z');
      expect(input.endTime.toISOString()).toBe('2026-08-01T10:30:00.000Z');
    });

    it('reads like a calendar entry: "Reply to <label>: <excerpt>"', () => {
      const input = messageToEventInput(baseMessage);
      expect(input.summary).toBe('Reply to @alex: Thanks for the kind words!');
    });

    it('falls back to the label alone when there is no text', () => {
      const input = messageToEventInput({ ...baseMessage, text: null });
      expect(input.summary).toBe('Reply to @alex');
    });

    it('falls back to the excerpt alone when there is no label', () => {
      const input = messageToEventInput({ ...baseMessage, targetLabel: null });
      expect(input.summary).toBe('Reply: Thanks for the kind words!');
    });

    it('never produces an empty title when both label and text are missing', () => {
      const input = messageToEventInput({
        ...baseMessage,
        text: null,
        targetLabel: null,
      });
      expect(input.summary).toBe('Scheduled reply');
    });

    it('strips the composer HTML out of the excerpt', () => {
      const input = messageToEventInput({
        ...baseMessage,
        text: '<p>Thanks &amp; welcome!</p>',
      });
      expect(input.summary).toBe('Reply to @alex: Thanks & welcome!');
    });

    it('truncates long text to <= 80 chars with an ellipsis', () => {
      const input = messageToEventInput({
        ...baseMessage,
        text: 'x'.repeat(200),
      });
      expect(input.summary.length).toBeLessThanOrEqual(80);
      expect(input.summary.endsWith('…')).toBe(true);
    });

    it('throws when the message has no scheduledAt', () => {
      expect(() =>
        messageToEventInput({ ...baseMessage, scheduledAt: null }),
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
