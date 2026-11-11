import { publishWarningsOf, warningsField } from './publish-warnings';

/** D4: the soft steps a publisher reports, as sentences for the post. */
describe('publishWarningsOf', () => {
  it('turns every known *Warning key into "<what>: <why>", in order', () => {
    expect(
      publishWarningsOf({
        coverWarning: 'too big',
        captionsWarning: 'bad SRT',
        collaboratorWarning: 'not eligible',
        firstCommentWarning: 'comments off',
        mediaWarning: 'left out 2 items',
        altTextWarning: 'refused',
        locationWarning: 'no place on video',
        thumbnailWarning: 'not a JPEG',
      }),
    ).toEqual([
      'Cover was not set: too big',
      'Captions were not added: bad SRT',
      'Collaborator was not invited: not eligible',
      'First comment was not posted: comments off',
      'Some media was left out: left out 2 items',
      'Alt text was not added: refused',
      'Location was not added: no place on video',
      'Thumbnail was not set: not a JPEG',
    ]);
  });

  it('surfaces a key it has no label for, so a new soft step is never lost', () => {
    expect(publishWarningsOf({ playlistAddWarning: 'quota' })).toEqual([
      'Playlist add: quota',
    ]);
  });

  it('ignores ids, non-strings, blanks and the contentWarning SETTING', () => {
    expect(
      publishWarningsOf({
        firstCommentId: 'c1',
        threadIds: ['a', 'b'],
        coverWarning: '   ',
        captionsWarning: 42,
        contentWarning: 'spoilers',
        Warning: 'no stem',
      }),
    ).toEqual([]);
  });

  it('copes with no metadata', () => {
    expect(publishWarningsOf(undefined)).toEqual([]);
    expect(publishWarningsOf(null)).toEqual([]);
  });

  it('warningsField adds the key only when there is something to say', () => {
    expect(warningsField({ firstCommentId: 'c1' })).toEqual({});
    expect(warningsField({ coverWarning: 'x' })).toEqual({
      warnings: ['Cover was not set: x'],
    });
  });
});
