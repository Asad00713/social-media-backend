import { ServiceUnavailableException } from '@nestjs/common';
import { parseQuickReplies } from './quick-replies';

describe('parseQuickReplies', () => {
  it('parses a JSON array', () => {
    expect(
      parseQuickReplies('["Thanks!","We will DM you","Glad you like it"]'),
    ).toEqual(['Thanks!', 'We will DM you', 'Glad you like it']);
  });

  it('parses a fenced JSON array', () => {
    const raw = '```json\n["Thanks!","We will DM you","Glad you like it"]\n```';
    expect(parseQuickReplies(raw)).toHaveLength(3);
  });

  it('parses numbered / bulleted / quoted lines', () => {
    const raw = '1. "Thanks!"\n2) - We will DM you\n• Glad you like it';
    expect(parseQuickReplies(raw)).toEqual([
      'Thanks!',
      'We will DM you',
      'Glad you like it',
    ]);
  });

  it('cuts a 90-char reply to at most 60 chars at a word boundary', () => {
    const long =
      'Thank you so much for reaching out to us today, we really appreciate it a lot friend';
    expect(long.length).toBeGreaterThan(80);
    const out = parseQuickReplies(JSON.stringify([long, 'Two', 'Three']));
    expect(out[0].length).toBeLessThanOrEqual(60);
    expect(long.startsWith(out[0])).toBe(true);
    expect(long[out[0].length]).toBe(' ');
    expect(out[0]).not.toMatch(/[,;:.\-\s]$/);
  });

  it('drops duplicates and empties, keeps the first 3', () => {
    expect(parseQuickReplies('["A","A","","B","C","D"]')).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  it('throws when fewer than 3 remain', () => {
    expect(() => parseQuickReplies('["A","B"]')).toThrow(
      ServiceUnavailableException,
    );
    expect(() => parseQuickReplies('["A","B"]')).toThrow(
      'AI returned too few suggestions',
    );
  });
});
