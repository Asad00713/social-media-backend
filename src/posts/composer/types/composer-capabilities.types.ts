/**
 * Per-platform composer capabilities. Drives:
 *   - UI rendering (which settings panel fields to show)
 *   - Validation (which fields are required)
 *   - Media validation (size/format/duration limits)
 *   - AI prompts (which features the platform supports)
 *
 * Adding a new platform = adding a registry entry. No UI code changes.
 */
export interface ComposerCapabilities {
  // Content fields supported
  supportsTitle: boolean;
  supportsBody: boolean;
  supportsDescription: boolean;
  supportsHashtags: boolean;
  supportsFirstComment: boolean;
  supportsThread: boolean;
  supportsPoll: boolean;
  supportsLocation: boolean;
  supportsMentions: boolean;
  supportsLinkPreview: boolean;

  // Platform-specific knobs (enum-like option sets)
  postTypes: string[];
  visibilityOptions: string[];
  replyControlOptions: string[];

  // Character limits
  maxCharsTitle?: number;
  maxCharsBody: number;
  maxCharsDescription?: number;
  maxCharsFirstComment?: number;

  // Media
  mediaConstraints: MediaConstraints;

  // Validation
  requiredFields: string[];
}

export interface MediaConstraints {
  imageMaxCount: number;
  imageMaxSizeMB: number;
  imageAllowedTypes: string[];
  imageAspectRatios: string[];

  videoMaxCount: number;
  videoMaxSizeMB: number;
  videoMaxDurationSec: number;
  videoMinDurationSec?: number;
  videoAllowedTypes: string[];
  videoAspectRatios: string[];

  carouselMaxCount?: number;
  requiresThumbnail?: boolean;
  requiresMediaOfType?: 'video' | 'image';
}
