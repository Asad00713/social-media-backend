import { zipEntryNames } from './zip-names';

describe('zipEntryNames', () => {
  it('sanitises, adds the extension once and numbers later duplicates', () => {
    expect(
      zipEntryNames([
        { name: 'Hero', mimeType: 'image/png', fileUrl: 'https://x/1' },
        { name: 'Hero', mimeType: 'image/png', fileUrl: 'https://x/2' },
        { name: 'Clip', mimeType: null, fileUrl: 'https://x/y/clip.MP4?v=1' },
        { name: 'a/b:c', mimeType: 'image/jpeg', fileUrl: 'https://x/3' },
        { name: 'Hero.png', mimeType: 'image/png', fileUrl: 'https://x/4' },
      ]),
    ).toEqual([
      'Hero.png',
      'Hero (2).png',
      'Clip.mp4',
      'a_b_c.jpg',
      'Hero (3).png',
    ]);
  });

  it.each([
    ['image/jpeg', '.jpg'],
    ['image/png', '.png'],
    ['image/gif', '.gif'],
    ['image/webp', '.webp'],
    ['video/mp4', '.mp4'],
    ['video/quicktime', '.mov'],
    ['application/pdf', '.pdf'],
  ])('maps %s to %s', (mimeType, ext) => {
    expect(
      zipEntryNames([{ name: 'f', mimeType, fileUrl: 'https://x/no-ext' }]),
    ).toEqual([`f${ext}`]);
  });

  it('replaces every unsafe character', () => {
    expect(
      zipEntryNames([
        {
          name: 'a/b\\c:d*e?f"g<h>i|j',
          mimeType: null,
          fileUrl: 'https://x/z',
        },
      ]),
    ).toEqual(['a_b_c_d_e_f_g_h_i_j']);
  });

  it('never yields a name yazl rejects (empty or a dot segment)', () => {
    expect(
      zipEntryNames([
        { name: '', mimeType: null, fileUrl: 'https://x/z' },
        { name: '..', mimeType: null, fileUrl: 'https://x/z' },
      ]),
    ).toEqual(['file', 'file (2)']);
  });

  it('skips a name a later duplicate would collide with', () => {
    expect(
      zipEntryNames([
        { name: 'Hero (2)', mimeType: 'image/png', fileUrl: 'https://x/1' },
        { name: 'Hero', mimeType: 'image/png', fileUrl: 'https://x/2' },
        { name: 'Hero', mimeType: 'image/png', fileUrl: 'https://x/3' },
      ]),
    ).toEqual(['Hero (2).png', 'Hero.png', 'Hero (3).png']);
  });

  it('ignores an unparsable URL', () => {
    expect(
      zipEntryNames([{ name: 'n', mimeType: null, fileUrl: 'not a url' }]),
    ).toEqual(['n']);
  });
});
