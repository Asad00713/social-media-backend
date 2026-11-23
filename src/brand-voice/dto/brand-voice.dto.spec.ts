import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RevertBrandVoiceDto, UpdateBrandVoiceDto } from './brand-voice.dto';

async function errorsFor(body: unknown) {
  return validate(plainToInstance(UpdateBrandVoiceDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('UpdateBrandVoiceDto', () => {
  it.each([
    [
      'five tones',
      { version: 1, tone: ['Warm', 'Clear', 'Playful', 'Bold', 'Calm'] },
    ],
    ['an unknown tone', { version: 1, tone: ['Loud'] }],
    ['a repeated tone', { version: 1, tone: ['Warm', 'Warm'] }],
    ['a null tone', { version: 1, tone: null }],
    ['241 code points', { version: 1, description: 'a'.repeat(241) }],
    [
      '120 coffee emoji (240 code points + 1)',
      { version: 1, description: '☕️'.repeat(120) + 'a' },
    ],
    ['a line break', { version: 1, description: 'one\ntwo' }],
    ['a carriage return', { version: 1, description: 'one\rtwo' }],
    ['a NUL in the description', { version: 1, description: 'a\u0000b' }],
    ['a NUL in a word to use', { version: 1, wordsUse: ['a\u0000'] }],
    ['a NUL in a word to avoid', { version: 1, wordsAvoid: ['ok', '\u0000'] }],
    [
      'a NUL in a tweak',
      { version: 1, channelTweaks: { linkedin: 'x\u0000' } },
    ],
    [
      'a lone surrogate in the description',
      { version: 1, description: 'a\ud800b' },
    ],
    [
      'a lone surrogate in a word to use',
      { version: 1, wordsUse: ['ok', '\ud800'] },
    ],
    [
      'a lone low surrogate in a word to avoid',
      { version: 1, wordsAvoid: ['\udc00x'] },
    ],
    [
      'a lone surrogate in a tweak',
      { version: 1, channelTweaks: { linkedin: 'x\ud800' } },
    ],
    ['a numeric description', { version: 1, description: 5 }],
    [
      '21 words',
      {
        version: 1,
        wordsUse: Array.from({ length: 21 }, (_, i) => `w${i}`),
      },
    ],
    ['a 41-char word', { version: 1, wordsAvoid: ['a'.repeat(41)] }],
    ['a non-string word', { version: 1, wordsUse: [5] }],
    ['an unknown platform', { version: 1, channelTweaks: { myspace: 'x' } }],
    [
      'an integration platform',
      { version: 1, channelTweaks: { google_drive: 'x' } },
    ],
    [
      'a 121-char tweak',
      { version: 1, channelTweaks: { linkedin: 'a'.repeat(121) } },
    ],
    [
      'a tweak with a line break',
      { version: 1, channelTweaks: { linkedin: 'a\nb' } },
    ],
    ['a non-string tweak', { version: 1, channelTweaks: { linkedin: 5 } }],
    ['an array of tweaks', { version: 1, channelTweaks: [] }],
    ['a null tweak map', { version: 1, channelTweaks: null }],
    ['emoji "some"', { version: 1, emojiLevel: 'some' }],
    ['hashtags "lots"', { version: 1, hashtagsMode: 'lots' }],
    ['emoji as an empty string', { version: 1, emojiLevel: '' }],
    ['hashtags as a number', { version: 1, hashtagsMode: 0 }],
    ['no version', { tone: ['Warm'] }],
    ['version 0', { version: 0, tone: ['Warm'] }],
    ['a fractional version', { version: 1.5, tone: ['Warm'] }],
    ['an unknown field', { version: 1, hasVoice: true }],
  ])('rejects %s', async (_name, body) => {
    expect((await errorsFor(body)).length).toBeGreaterThan(0);
  });

  it('accepts a null description, 240 code points of coffee emoji, an empty tweak line and a full valid body', async () => {
    expect(await errorsFor({ version: 1, description: null })).toEqual([]);
    expect(
      await errorsFor({
        version: 1,
        description: '☕️'.repeat(120),
      }),
    ).toEqual([]);
    expect(
      await errorsFor({ version: 2, channelTweaks: { linkedin: '' } }),
    ).toEqual([]);
    expect(
      await errorsFor({
        version: 3,
        tone: ['Warm', 'Bold'],
        description: 'We sell warm bread.',
        wordsUse: ['fresh', 'local'],
        wordsAvoid: ['cheap'],
        emojiLevel: 'none',
        hashtagsMode: 'saved_groups',
        channelTweaks: { linkedin: 'Longer and more formal', twitter: '' },
      }),
    ).toEqual([]);
  });

  it('accepts null emoji and hashtags, which reset them to not set', async () => {
    expect(await errorsFor({ version: 1, emojiLevel: null })).toEqual([]);
    expect(await errorsFor({ version: 1, hashtagsMode: null })).toEqual([]);
    expect(
      await errorsFor({ version: 1, emojiLevel: null, hashtagsMode: null }),
    ).toEqual([]);
  });

  it('accepts a well-formed surrogate pair (an emoji) in every string field', async () => {
    expect(
      await errorsFor({
        version: 1,
        description: 'Coffee \u{1F600}',
        wordsUse: ['\u{1F600}'],
        wordsAvoid: ['x\u{1F600}'],
        channelTweaks: { linkedin: '\u{1F600} more formal' },
      }),
    ).toEqual([]);
  });

  it('accepts a body with only the version (the service answers NOTHING_TO_SAVE)', async () => {
    expect(await errorsFor({ version: 1 })).toEqual([]);
  });
});

describe('RevertBrandVoiceDto', () => {
  const check = (body: unknown) =>
    validate(plainToInstance(RevertBrandVoiceDto, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it.each([
    [{}],
    [{ version: 0 }],
    [{ version: '2' }],
    [{ version: 1, tone: [] }],
  ])('rejects %j', async (body) => {
    expect((await check(body)).length).toBeGreaterThan(0);
  });

  it('accepts a positive integer version', async () => {
    expect(await check({ version: 3 })).toEqual([]);
  });
});
