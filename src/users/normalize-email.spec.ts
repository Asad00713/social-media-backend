import { normalizeEmail } from './normalize-email';

describe('normalizeEmail', () => {
  it.each([
    ['Sara@Daybreak.co', 'sara@daybreak.co'],
    ['  sara@daybreak.co  ', 'sara@daybreak.co'],
    ['SARA@DAYBREAK.CO', 'sara@daybreak.co'],
    ['sara@daybreak.co', 'sara@daybreak.co'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeEmail(raw)).toBe(expected);
  });
});
