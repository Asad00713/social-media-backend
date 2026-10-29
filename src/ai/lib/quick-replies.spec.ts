import { ServiceUnavailableException } from '@nestjs/common';
import { parseQuickReplies } from './quick-replies';

describe('parseQuickReplies', () => {
  it('parses a JSON array of exactly 3', () => {
    expect(
      parseQuickReplies('["Thanks!","We will DM you","Glad you like it"]'),
    ).toEqual(['Thanks!', 'We will DM you', 'Glad you like it']);
  });

  it('tolerates a ```json fence', () => {
    const raw = '```json\n["Thanks!","We will DM you","Glad you like it"]\n```';
    expect(parseQuickReplies(raw)).toHaveLength(3);
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

  it.each([
    ['2 items', '["A","B"]'],
    ['4 items', '["A","B","C","D"]'],
    ['an object', '{"replies":["A","B","C"]}'],
    ['a bare string', '"A B C"'],
    ['non-strings', '["A",2,"C"]'],
    ['an empty string', '["A","","C"]'],
    ['a blank string', '["A","   ","C"]'],
    ['numbered prose', '1. Thanks!\n2. We will DM you\n3. Glad you like it'],
    ['prose around JSON', 'Sure! ["A","B","C"]'],
    ['duplicates', '["A","A","B"]'],
    ['empty input', ''],
  ])('rejects %s with the clean 503', (_name, raw) => {
    expect(() => parseQuickReplies(raw)).toThrow(ServiceUnavailableException);
    expect(() => parseQuickReplies(raw)).toThrow(
      'AI returned too few suggestions',
    );
  });
});
