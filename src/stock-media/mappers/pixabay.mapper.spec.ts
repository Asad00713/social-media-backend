import { mapPixabayImage, mapPixabayVideo } from './pixabay.mapper';
import type {
  PixabayImage,
  PixabayVideo,
} from '../providers/pixabay.service';

const image: PixabayImage = {
  id: 4321,
  pageURL: 'https://pixabay.com/photos/mountain-4321/',
  previewURL: 'https://cdn.pixabay.com/photo/preview.jpg',
  webformatURL: 'https://cdn.pixabay.com/photo/webformat.jpg',
  largeImageURL: 'https://cdn.pixabay.com/photo/large.jpg',
  imageWidth: 4000,
  imageHeight: 2667,
  user: 'Jane Doe',
  user_id: 55,
  userImageURL: 'https://cdn.pixabay.com/user/jane.jpg',
};

const video: PixabayVideo = {
  id: 8765,
  pageURL: 'https://pixabay.com/videos/waves-8765/',
  duration: 20,
  user: 'Ocean Films',
  picture_id: 'pic123',
  videos: {
    large: {
      url: 'https://cdn.pixabay.com/video/large.mp4',
      width: 1920,
      height: 1080,
      thumbnail: 'https://cdn.pixabay.com/video/large-thumb.jpg',
    },
    medium: {
      url: 'https://cdn.pixabay.com/video/medium.mp4',
      width: 1280,
      height: 720,
      thumbnail: 'https://cdn.pixabay.com/video/medium-thumb.jpg',
    },
    small: {
      url: 'https://cdn.pixabay.com/video/small.mp4',
      width: 640,
      height: 360,
      thumbnail: 'https://cdn.pixabay.com/video/small-thumb.jpg',
    },
    tiny: {
      url: 'https://cdn.pixabay.com/video/tiny.mp4',
      width: 320,
      height: 180,
      thumbnail: 'https://cdn.pixabay.com/video/tiny-thumb.jpg',
    },
  },
};

describe('mapPixabayImage', () => {
  it('maps to the normalized envelope as an image', () => {
    const item = mapPixabayImage(image);
    expect(item.provider).toBe('pixabay');
    expect(item.providerId).toBe('4321');
    expect(item.type).toBe('image');
    expect(item.previewUrl).toBe(
      'https://cdn.pixabay.com/photo/webformat.jpg',
    );
    expect(item.fullUrl).toBe('https://cdn.pixabay.com/photo/large.jpg');
    expect(item.width).toBe(4000);
    expect(item.height).toBe(2667);
    expect(item.authorName).toBe('Jane Doe');
    expect(item.authorUrl).toBe('https://pixabay.com/photos/mountain-4321/');
    expect(item.providerUrl).toBe('https://pixabay.com/photos/mountain-4321/');
    expect(item.downloadTriggerUrl).toBeUndefined();
  });
});

describe('mapPixabayVideo', () => {
  it('maps to the normalized envelope as a video with a thumbnail', () => {
    const item = mapPixabayVideo(video);
    expect(item.provider).toBe('pixabay');
    expect(item.providerId).toBe('8765');
    expect(item.type).toBe('video');
    expect(item.fullUrl).toBe('https://cdn.pixabay.com/video/large.mp4');
    expect(item.previewUrl).toBe(
      'https://cdn.pixabay.com/video/large-thumb.jpg',
    );
    expect(item.width).toBe(1920);
    expect(item.height).toBe(1080);
    expect(item.durationSec).toBe(20);
    expect(item.authorName).toBe('Ocean Films');
    expect(item.authorUrl).toBe('https://pixabay.com/videos/waves-8765/');
    expect(item.providerUrl).toBe('https://pixabay.com/videos/waves-8765/');
  });

  it('falls back to a vimeocdn thumbnail when no large/medium thumbnail is present', () => {
    const videoWithoutThumbnails: PixabayVideo = {
      ...video,
      videos: {
        ...video.videos,
        large: { ...video.videos.large, thumbnail: '' },
        medium: { ...video.videos.medium, thumbnail: '' },
      },
    };

    const item = mapPixabayVideo(videoWithoutThumbnails);
    expect(item.previewUrl).toBe(
      'https://i.vimeocdn.com/video/pic123_295x166.jpg',
    );
  });
});
