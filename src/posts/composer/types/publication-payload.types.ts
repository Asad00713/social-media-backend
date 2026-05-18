import type { SupportedPlatform } from '../../../drizzle/schema/channels.schema';
import type { BaseContent, DraftMediaItem } from './draft.types';

/**
 * The result of resolving a Draft against a specific ChannelTarget.
 * This is what the Publication Orchestrator (Phase 2) and Preview
 * Renderers (Phase 2) consume — NOT the raw draft state. Single source
 * of truth for "what will actually publish to this channel."
 */
export interface PublicationPayload {
  channelId: string;
  platform: SupportedPlatform;
  text: string;
  mediaItems: DraftMediaItem[];
  hashtags: string[];
  mentions: BaseContent['mentions'];
  linkPreview?: BaseContent['linkPreview'];
  platformSpecific: Record<string, unknown>;
  scheduleAt?: string;
}
