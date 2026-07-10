import { mapPexelsPhoto, mapPexelsVideo, pickVideoFile } from './pexels.mapper';
import type { PexelsPhoto, PexelsVideo } from '../../pexels/pexels.service';

const photo: PexelsPhoto = {
  id: 12345,
  width: 5000,
  height: 3333,
  url: 'https://www.pexels.com/photo/12345/',
  photographer: 'John Roe',
  photographerUrl: 'https://www.pexels.com/@johnroe',
  photographerId: 99,
  avgColor: '#222',
  src: {
    original: 'https://images.pexels.com/original.jpg',
    large2x: 'https://images.pexels.com/large2x.jpg',
    large: 'https://images.pexels.com/large.jpg',
    medium: 'https://images.pexels.com/medium.jpg',
    small: 'https://images.pexels.com/small.jpg',
    portrait: 'https://images.pexels.com/portrait.jpg',
    landscape: 'https://images.pexels.com/landscape.jpg',
    tiny: 'https://images.pexels.com/tiny.jpg',
  },
  alt: 'a mountain',
};

const video: PexelsVideo = {
  id: 6789,
  width: 1920,
  height: 1080,
  url: 'https://www.pexels.com/video/6789/',
  image: 'https://images.pexels.com/video-thumb.jpg',
  duration: 15,
  user: { id: 7, name: 'Cara Coe', url: 'https://www.pexels.com/@caracoe' },
  videoFiles: [
    { id: 1, quality: 'sd', fileType: 'video/mp4', width: 640, height: 360, fps: 30, link: 'https://player.vimeo.com/sd.mp4' },
    { id: 2, quality: 'hd', fileType: 'video/mp4', width: 1920, height: 1080, fps: 30, link: 'https://player.vimeo.com/hd.mp4' },
  ],
  videoPictures: [],
};

describe('mapPexelsPhoto', () => {
  it('maps to the normalized envelope as an image', () => {
    const item = mapPexelsPhoto(photo);
    expect(item.provider).toBe('pexels');
    expect(item.providerId).toBe('12345');
    expect(item.type).toBe('image');
    expect(item.previewUrl).toBe('https://images.pexels.com/medium.jpg');
    expect(item.fullUrl).toBe('https://images.pexels.com/large2x.jpg');
    expect(item.authorName).toBe('John Roe');
    expect(item.authorUrl).toBe('https://www.pexels.com/@johnroe');
    expect(item.providerUrl).toBe('https://www.pexels.com/photo/12345/');
    expect(item.downloadTriggerUrl).toBeUndefined();
  });
});

describe('pickVideoFile', () => {
  it('prefers an hd mp4 file', () => {
    expect(pickVideoFile(video.videoFiles).link).toBe('https://player.vimeo.com/hd.mp4');
  });
  it('falls back to the first file when no hd mp4', () => {
    const files = [video.videoFiles[0]];
    expect(pickVideoFile(files).link).toBe('https://player.vimeo.com/sd.mp4');
  });
});

describe('mapPexelsVideo', () => {
  it('maps to the normalized envelope as a video', () => {
    const item = mapPexelsVideo(video);
    expect(item.provider).toBe('pexels');
    expect(item.providerId).toBe('6789');
    expect(item.type).toBe('video');
    expect(item.previewUrl).toBe('https://images.pexels.com/video-thumb.jpg');
    expect(item.fullUrl).toBe('https://player.vimeo.com/hd.mp4');
    expect(item.durationSec).toBe(15);
    expect(item.authorName).toBe('Cara Coe');
    expect(item.authorUrl).toBe('https://www.pexels.com/@caracoe');
  });
});
