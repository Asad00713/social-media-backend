import { savedHashtagsFrom } from './saved-hashtags';

describe('savedHashtagsFrom', () => {
  it('takes hashtags from group text, dedupes case-insensitively, keeps unicode and caps at 30', () => {
    expect(
      savedHashtagsFrom(['#Coffee #karachi lovely', '#coffee #چائے']),
    ).toEqual(['#Coffee', '#karachi', '#چائے']);
  });

  it('caps at 30 by default', () => {
    const many = Array.from({ length: 40 }, (_, i) => `#tag${i}`).join(' ');
    const out = savedHashtagsFrom([many]);
    expect(out).toHaveLength(30);
    expect(out[29]).toBe('#tag29');
  });

  it('honours an explicit max', () => {
    expect(savedHashtagsFrom(['#a #b #c'], 2)).toEqual(['#a', '#b']);
  });

  it('keeps digits and underscores, stops at punctuation', () => {
    expect(savedHashtagsFrom(['#web_3 #2026,#end.'])).toEqual([
      '#web_3',
      '#2026',
      '#end',
    ]);
  });

  it('ignores text without hashtags and a bare #', () => {
    expect(savedHashtagsFrom(['no tags # here', ''])).toEqual([]);
  });
});
