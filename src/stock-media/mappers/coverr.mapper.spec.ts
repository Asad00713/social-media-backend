import { mapCoverrVideo } from './coverr.mapper';
import type { CoverrVideo } from '../providers/coverr.service';

const video: CoverrVideo = {
  id: 'abc123',
  title: 'Ocean waves',
  urls: {
    mp4: 'https://storage.coverr.co/videos/abc123.mp4?signature=xyz',
    mp4_download: 'https://storage.coverr.co/videos/abc123-download.mp4?signature=xyz',
    poster: 'https://storage.coverr.co/videos/abc123-poster.jpg',
  },
  max_width: 1920,
  max_height: 1080,
  duration: 12,
};

describe('mapCoverrVideo', () => {
  it('maps to the normalized envelope as a video', () => {
    const item = mapCoverrVideo(video);
    expect(item.provider).toBe('coverr');
    expect(item.providerId).toBe('abc123');
    expect(item.type).toBe('video');
    expect(item.fullUrl).toBe(
      'https://storage.coverr.co/videos/abc123.mp4?signature=xyz',
    );
    expect(item.previewUrl).toBe(
      'https://storage.coverr.co/videos/abc123-poster.jpg',
    );
    expect(item.width).toBe(1920);
    expect(item.height).toBe(1080);
    expect(item.durationSec).toBe(12);
    expect(item.authorName).toBe('Coverr');
    expect(item.authorUrl).toBe('https://coverr.co');
    expect(item.providerUrl).toBe('https://coverr.co/videos/abc123');
    expect(item.downloadTriggerUrl).toBeUndefined();
  });

  it('falls back to mp4_download when urls.mp4 is absent', () => {
    const fallbackVideo: CoverrVideo = {
      id: 456,
      urls: {
        mp4_download: 'https://storage.coverr.co/videos/456-download.mp4?signature=xyz',
        thumbnail: 'https://storage.coverr.co/videos/456-thumb.jpg',
      },
      info: { width: 1280, height: 720 },
      duration: 8,
    };

    const item = mapCoverrVideo(fallbackVideo);
    expect(item.fullUrl).toBe(
      'https://storage.coverr.co/videos/456-download.mp4?signature=xyz',
    );
    expect(item.previewUrl).toBe(
      'https://storage.coverr.co/videos/456-thumb.jpg',
    );
    expect(item.width).toBe(1280);
    expect(item.height).toBe(720);
    expect(item.providerUrl).toBe('https://coverr.co/videos/456');
  });
});
