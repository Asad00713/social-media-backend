import { mediaTypeFromUpload } from './upload-type';

describe('mediaTypeFromUpload', () => {
  it.each([
    [{ resourceType: 'image' as const, format: 'gif' }, 'gif'],
    [{ resourceType: 'image' as const, mimeType: 'image/gif' }, 'gif'],
    [{ resourceType: 'image' as const, format: 'pdf' }, 'document'],
    [{ resourceType: 'raw' as const }, 'document'],
    [{ resourceType: 'video' as const }, 'video'],
    [{ resourceType: 'image' as const, format: 'png' }, 'image'],
  ])('%j → %s', (upload, expected) => {
    expect(mediaTypeFromUpload(upload)).toBe(expected);
  });
});
