import { safeKeyExtension } from './cloudflare-r2.service';

// Fix round 2: the presigned key is built from the client's filename, so its
// extension must never carry a path character into the key.
describe('safeKeyExtension', () => {
  it.each([
    ['clip.MP4', 'video/mp4', '.mp4'],
    ['a.b.webm', 'video/webm', '.webm'],
    ['voice.m4a', 'audio/mp4', '.m4a'],
  ])('keeps a plain extension: %s → %s', (filename, type, expected) => {
    expect(safeKeyExtension(type, filename)).toBe(expected);
  });

  it.each([
    ['x.mp4/../../etc', 'video/mp4', '.mp4'],
    ['x./..', 'video/quicktime', '.mov'],
    ['x.mp4%2F..', 'video/webm', '.webm'],
    ['x.verylongext', 'video/mp4', '.mp4'],
    ['x.mp-4', 'image/png', '.png'],
    ['x.mp4?a=b', 'audio/ogg', '.ogg'],
    ['x.éxe', 'image/gif', '.gif'],
  ])(
    'drops an unsafe extension and maps the mime type: %s',
    (filename, type, expected) => {
      expect(safeKeyExtension(type, filename)).toBe(expected);
    },
  );

  it('is empty when neither the name nor the mime type gives a safe one', () => {
    expect(safeKeyExtension('application/x-unknown', 'x.a/b')).toBe('');
    expect(safeKeyExtension('application/x-unknown')).toBe('');
  });

  it('every result is a dot plus 1–8 lowercase alphanumerics, or empty', () => {
    const samples = ['..', '.', 'a.', '.hidden', 'x.TXT', 'x.a\\b', 'x.a b'];
    for (const name of samples) {
      expect(safeKeyExtension('video/mp4', name)).toMatch(
        /^(\.[a-z0-9]{1,8})?$/,
      );
    }
  });
});
