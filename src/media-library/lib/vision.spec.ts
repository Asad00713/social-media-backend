import { cleanAltText, visionImageUrl } from './vision';

describe('visionImageUrl', () => {
  it('inserts the resize transform after /upload/ on Cloudinary image URLs', () => {
    expect(
      visionImageUrl('https://res.cloudinary.com/demo/image/upload/v1/x.gif'),
    ).toBe(
      'https://res.cloudinary.com/demo/image/upload/f_jpg,w_1024,c_limit/v1/x.gif',
    );
  });

  it('leaves other URLs unchanged', () => {
    const r2 = 'https://pub-abc.r2.dev/ws/x.png';
    expect(visionImageUrl(r2)).toBe(r2);
  });
});

describe('cleanAltText', () => {
  it('strips wrapping quotes and a leading "Image of "', () => {
    expect(cleanAltText('"Image of a red bike leaning on a wall."')).toBe(
      'a red bike leaning on a wall.',
    );
  });

  it('strips "Alt text:" and "Picture of " case-insensitively', () => {
    expect(cleanAltText('ALT TEXT: picture of a dog')).toBe('a dog');
  });

  it('collapses whitespace', () => {
    expect(cleanAltText('a  red\n bike')).toBe('a red bike');
  });

  it('caps at 250 characters on a word boundary', () => {
    const out = cleanAltText('word '.repeat(100));
    expect(out.length).toBeLessThanOrEqual(250);
    expect(out.endsWith('word')).toBe(true);
  });
});
