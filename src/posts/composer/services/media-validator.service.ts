import { Injectable } from '@nestjs/common';
import type { DraftMediaItem } from '../types/draft.types';
import type { MediaConstraints } from '../types/composer-capabilities.types';

export interface MediaValidationError {
  kind:
    | 'image_too_large'
    | 'image_count_exceeded'
    | 'image_type_unsupported'
    | 'image_aspect_mismatch'
    | 'video_too_large'
    | 'video_count_exceeded'
    | 'video_too_long'
    | 'video_too_short'
    | 'video_type_unsupported'
    | 'video_aspect_mismatch'
    | 'media_type_required'
    | 'thumbnail_required';
  mediaId?: string;
  message: string;
}

export interface MediaValidationResult {
  ok: boolean;
  errors: MediaValidationError[];
  warnings: MediaValidationError[];
}

@Injectable()
export class MediaValidatorService {
  validate(
    items: DraftMediaItem[],
    constraints: MediaConstraints,
  ): MediaValidationResult {
    const errors: MediaValidationError[] = [];
    const warnings: MediaValidationError[] = [];

    const images = items.filter((m) => m.type === 'image' || m.type === 'gif');
    const videos = items.filter((m) => m.type === 'video');

    if (constraints.requiresMediaOfType === 'video' && videos.length === 0) {
      errors.push({
        kind: 'media_type_required',
        message: 'This platform requires a video to publish',
      });
    }
    if (constraints.requiresMediaOfType === 'image' && images.length === 0) {
      errors.push({
        kind: 'media_type_required',
        message: 'This platform requires an image to publish',
      });
    }

    if (images.length > constraints.imageMaxCount) {
      errors.push({
        kind: 'image_count_exceeded',
        message: `Too many images: ${images.length}, max ${constraints.imageMaxCount}`,
      });
    }
    for (const img of images) {
      const sizeMB = img.sizeBytes / (1024 * 1024);
      if (sizeMB > constraints.imageMaxSizeMB) {
        errors.push({
          kind: 'image_too_large',
          mediaId: img.id,
          message: `Image ${sizeMB.toFixed(1)}MB exceeds ${constraints.imageMaxSizeMB}MB`,
        });
      }
      if (
        constraints.imageAspectRatios.length > 0 &&
        img.width != null &&
        img.height != null &&
        !this.matchesAspect(
          img.width,
          img.height,
          constraints.imageAspectRatios,
        )
      ) {
        errors.push({
          kind: 'image_aspect_mismatch',
          mediaId: img.id,
          message: `Image aspect ratio not supported (allowed: ${constraints.imageAspectRatios.join(', ')})`,
        });
      }
    }

    if (videos.length > constraints.videoMaxCount) {
      errors.push({
        kind: 'video_count_exceeded',
        message: `Too many videos: ${videos.length}, max ${constraints.videoMaxCount}`,
      });
    }
    for (const v of videos) {
      const sizeMB = v.sizeBytes / (1024 * 1024);
      if (sizeMB > constraints.videoMaxSizeMB) {
        errors.push({
          kind: 'video_too_large',
          mediaId: v.id,
          message: `Video ${sizeMB.toFixed(1)}MB exceeds ${constraints.videoMaxSizeMB}MB`,
        });
      }
      if (
        v.durationSec != null &&
        v.durationSec > constraints.videoMaxDurationSec
      ) {
        errors.push({
          kind: 'video_too_long',
          mediaId: v.id,
          message: `Video ${v.durationSec}s exceeds ${constraints.videoMaxDurationSec}s`,
        });
      }
      if (
        constraints.videoMinDurationSec != null &&
        v.durationSec != null &&
        v.durationSec < constraints.videoMinDurationSec
      ) {
        errors.push({
          kind: 'video_too_short',
          mediaId: v.id,
          message: `Video ${v.durationSec}s under minimum ${constraints.videoMinDurationSec}s`,
        });
      }
      if (
        constraints.videoAspectRatios.length > 0 &&
        v.width != null &&
        v.height != null &&
        !this.matchesAspect(v.width, v.height, constraints.videoAspectRatios)
      ) {
        errors.push({
          kind: 'video_aspect_mismatch',
          mediaId: v.id,
          message: `Video aspect ratio not supported (allowed: ${constraints.videoAspectRatios.join(', ')})`,
        });
      }
    }

    return { ok: errors.length === 0, errors, warnings };
  }

  private matchesAspect(
    width: number,
    height: number,
    allowed: string[],
  ): boolean {
    const actual = width / height;
    for (const ratio of allowed) {
      const [w, h] = ratio.split(':').map(Number);
      const target = w / h;
      if (Math.abs(actual - target) < 0.05) return true;
    }
    return false;
  }
}
