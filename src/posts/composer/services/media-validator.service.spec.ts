import { MediaValidatorService } from './media-validator.service';
import type { DraftMediaItem } from '../types/draft.types';
import type { MediaConstraints } from '../types/composer-capabilities.types';

describe('MediaValidatorService', () => {
  let service: MediaValidatorService;

  const twitterImageConstraints: MediaConstraints = {
    imageMaxCount: 4,
    imageMaxSizeMB: 5,
    imageAllowedTypes: ['image/jpeg', 'image/png'],
    imageAspectRatios: [],
    videoMaxCount: 1,
    videoMaxSizeMB: 512,
    videoMaxDurationSec: 140,
    videoAllowedTypes: ['video/mp4'],
    videoAspectRatios: [],
  };

  const igReelConstraints: MediaConstraints = {
    ...twitterImageConstraints,
    videoMaxDurationSec: 90,
    videoAspectRatios: ['9:16'],
    requiresMediaOfType: 'video',
  };

  function img(sizeMB: number, width = 1080, height = 1080): DraftMediaItem {
    return { id: 'm', type: 'image', url: 'x', sizeBytes: sizeMB * 1024 * 1024, width, height };
  }

  function video(sizeMB: number, durSec: number, width = 1920, height = 1080): DraftMediaItem {
    return {
      id: 'm',
      type: 'video',
      url: 'x',
      sizeBytes: sizeMB * 1024 * 1024,
      width,
      height,
      durationSec: durSec,
    };
  }

  beforeEach(() => {
    service = new MediaValidatorService();
  });

  it('passes valid Twitter image', () => {
    const result = service.validate([img(2)], twitterImageConstraints);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects oversize Twitter image', () => {
    const result = service.validate([img(8)], twitterImageConstraints);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ kind: 'image_too_large' }));
  });

  it('rejects too many Twitter images', () => {
    const result = service.validate(
      [img(1), img(1), img(1), img(1), img(1)],
      twitterImageConstraints,
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ kind: 'image_count_exceeded' }));
  });

  it('rejects video exceeding IG Reel duration', () => {
    const result = service.validate([video(200, 120)], igReelConstraints);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ kind: 'video_too_long' }));
  });

  it('rejects video with wrong aspect ratio for IG Reel', () => {
    const result = service.validate([video(100, 30, 1920, 1080)], igReelConstraints);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ kind: 'video_aspect_mismatch' }));
  });

  it('rejects when platform requires video but only image present', () => {
    const result = service.validate([img(2)], igReelConstraints);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ kind: 'media_type_required' }));
  });

  it('passes valid IG Reel video', () => {
    const result = service.validate([video(50, 60, 1080, 1920)], igReelConstraints);
    expect(result.ok).toBe(true);
  });
});
