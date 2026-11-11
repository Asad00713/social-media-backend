import { BadRequestException } from '@nestjs/common';
import { assertNoOpenBlanks, findOpenBlanks } from './template-blanks';

/** D5/S2: an unfilled `{{blank}}` never reaches a platform. */
describe('findOpenBlanks', () => {
  const thread = (texts: string[], postType?: string) => ({
    platformSpecific: {
      ...(postType ? { postType } : {}),
      thread: texts.map((text) => ({ text })),
    },
  });

  it('finds a blank in the shared caption for every platform that inherits it', () => {
    expect(
      findOpenBlanks({
        base: { text: 'Meet our {{product_name}}' },
        perPlatform: {},
        platforms: ['twitter', 'bluesky'],
      }),
    ).toEqual([
      { platform: 'twitter', where: 'caption', name: 'product_name' },
      { platform: 'bluesky', where: 'caption', name: 'product_name' },
    ]);
  });

  it('reads the channel’s own caption instead of the shared one', () => {
    expect(
      findOpenBlanks({
        base: { text: 'Meet our {{product_name}}' },
        perPlatform: { bluesky: { overrides: { text: 'All filled in' } } },
        platforms: ['bluesky'],
      }),
    ).toEqual([]);
    expect(
      findOpenBlanks({
        base: { text: 'fine' },
        perPlatform: { bluesky: { overrides: { text: 'On {{ date }}' } } },
        platforms: ['bluesky'],
      }),
    ).toEqual([{ platform: 'bluesky', where: 'caption', name: 'date' }]);
  });

  it('finds one in a thread post that will be published', () => {
    expect(
      findOpenBlanks({
        base: { text: 'one' },
        perPlatform: { twitter: thread(['one', 'two {{cta}}'], 'thread') },
        platforms: ['twitter'],
      }),
    ).toEqual([{ platform: 'twitter', where: 'thread post 2', name: 'cta' }]);
  });

  it('ignores a stale thread on a Post, and platforms not being published', () => {
    expect(
      findOpenBlanks({
        base: { text: 'one' },
        perPlatform: {
          twitter: thread(['one', '{{cta}}'], 'post'),
          mastodon: { overrides: { text: '{{cta}}' } },
        },
        platforms: ['twitter'],
      }),
    ).toEqual([]);
  });

  it.each([
    '{Hot|Iced} latte',
    '{{tag_#1}} is prose, not a blank',
    'an unclosed {{product_name',
    'no braces at all',
  ])('is not fooled by %p', (text) => {
    expect(
      findOpenBlanks({ base: { text }, perPlatform: {}, platforms: ['x'] }),
    ).toEqual([]);
  });
});

describe('assertNoOpenBlanks', () => {
  it('names the first blank and counts the rest', () => {
    expect(() =>
      assertNoOpenBlanks({
        base: { text: '{{a}} and {{b}}' },
        perPlatform: {},
        platforms: ['twitter', 'bluesky'],
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      assertNoOpenBlanks({
        base: { text: '{{a}}' },
        perPlatform: {},
        platforms: ['twitter', 'bluesky'],
      }),
    ).toThrow(/\{\{a\}\} \(twitter caption\).*2 blanks/);
  });

  it('passes a finished post', () => {
    expect(() =>
      assertNoOpenBlanks({
        base: { text: 'done' },
        perPlatform: {},
        platforms: ['twitter'],
      }),
    ).not.toThrow();
  });
});
