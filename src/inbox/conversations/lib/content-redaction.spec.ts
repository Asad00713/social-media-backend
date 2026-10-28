import { isContentRedacted as inboxServiceCopy } from '../../inbox.service';
import { isContentRedacted } from './content-redaction';

type Input = Parameters<typeof isContentRedacted>[0];

const CASES: Input[] = [
  { platform: 'youtube', text: null },
  { platform: 'youtube', text: '' },
  { platform: 'youtube', text: 'hello' },
  { platform: 'facebook', text: null },
  { platform: 'facebook', text: '' },
  { platform: 'bluesky', text: 'hi' },
];

describe('isContentRedacted', () => {
  it.each([
    [CASES[0], true],
    [CASES[1], false], // genuinely empty is not wiped
    [CASES[2], false],
    [CASES[3], false], // only YouTube is wiped by retention
  ])('%j -> %s', (input, expected) => {
    expect(isContentRedacted(input)).toBe(expected);
  });

  it('agrees with the copy in inbox.service until Foundation re-exports it', () => {
    for (const c of CASES) {
      expect(isContentRedacted(c)).toBe(inboxServiceCopy(c));
    }
  });
});
