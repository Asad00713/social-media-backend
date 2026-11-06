import { normalizeFolderKind, normalizeSnippetType } from './folder-kind';

describe('normalizeFolderKind', () => {
  it.each([
    ['image', 'media'],
    ['video', 'media'],
    ['gif', 'media'],
    ['document', 'media'],
    ['template', 'template'],
    ['media', 'media'],
    ['text_snippet', 'text_snippet'],
    ['link', 'link'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeFolderKind(input)).toBe(expected);
  });

  it('passes unknown and non-string values through for the validator', () => {
    expect(normalizeFolderKind('banana')).toBe('banana');
    expect(normalizeFolderKind(undefined)).toBeUndefined();
    expect(normalizeFolderKind(7)).toBe(7);
  });
});

describe('normalizeSnippetType', () => {
  it("maps 'bio' to 'signature'", () => {
    expect(normalizeSnippetType('bio')).toBe('signature');
  });

  it.each(['caption', 'hashtags', 'cta', 'signature', 'other'])(
    'keeps %s',
    (v) => {
      expect(normalizeSnippetType(v)).toBe(v);
    },
  );

  it('passes unknown values through', () => {
    expect(normalizeSnippetType('nope')).toBe('nope');
    expect(normalizeSnippetType(undefined)).toBeUndefined();
  });
});
