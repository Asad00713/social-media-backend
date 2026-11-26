// No real request may leave a test: both fetches are stubbed, though
// validation alone never sends one.
jest.mock('undici', () => ({
  ...jest.requireActual<typeof import('undici')>('undici'),
  fetch: jest.fn(() =>
    Promise.reject(new Error('undici fetch is stubbed in this spec')),
  ),
}));
beforeEach(() => {
  jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('global fetch is stubbed in this spec'));
});
afterEach(() => jest.restoreAllMocks());

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { TrackUnsplashDownloadDto } from './unsplash-download.dto';

const errorsFor = (body: unknown) =>
  validateSync(plainToInstance(TrackUnsplashDownloadDto, body), {
    whitelist: true,
    forbidNonWhitelisted: false,
  });

describe('TrackUnsplashDownloadDto', () => {
  it('accepts a download location string', () => {
    expect(
      errorsFor({
        downloadLocation: 'https://api.unsplash.com/photos/x/download',
      }),
    ).toEqual([]);
  });

  it.each([
    ['a missing value', {}],
    ['an empty string', { downloadLocation: '' }],
    ['a number', { downloadLocation: 42 }],
    ['an over-long value', { downloadLocation: 'x'.repeat(2049) }],
  ])('refuses %s', (_what, body) => {
    expect(errorsFor(body)).not.toEqual([]);
  });
});
