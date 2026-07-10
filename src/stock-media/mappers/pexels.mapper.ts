import type { PexelsPhoto, PexelsVideo } from '../../pexels/pexels.service';
import type { StockMediaItem } from '../stock-media.types';

type PexelsVideoFile = PexelsVideo['videoFiles'][number];

/** Choose the best playable file: prefer an hd mp4, then any mp4, then the first. */
export function pickVideoFile(files: PexelsVideoFile[]): PexelsVideoFile {
  const mp4s = files.filter((f) => f.fileType === 'video/mp4');
  const hd = mp4s.find((f) => f.quality === 'hd');
  return hd ?? mp4s[0] ?? files[0];
}

export function mapPexelsPhoto(photo: PexelsPhoto): StockMediaItem {
  return {
    provider: 'pexels',
    providerId: String(photo.id),
    type: 'image',
    previewUrl: photo.src.medium,
    fullUrl: photo.src.large2x,
    width: photo.width,
    height: photo.height,
    authorName: photo.photographer,
    authorUrl: photo.photographerUrl,
    providerUrl: photo.url,
  };
}

export function mapPexelsVideo(video: PexelsVideo): StockMediaItem {
  const file = pickVideoFile(video.videoFiles);
  return {
    provider: 'pexels',
    providerId: String(video.id),
    type: 'video',
    previewUrl: video.image,
    fullUrl: file.link,
    width: video.width,
    height: video.height,
    durationSec: video.duration,
    authorName: video.user.name,
    authorUrl: video.user.url,
    providerUrl: video.url,
  };
}
