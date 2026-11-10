import { Injectable } from '@nestjs/common';
import { type LinkPreview, readLinkPreview } from '../../lib/link-preview';

/**
 * The composer's link preview: a page's title, description and image, for
 * prefilling a Facebook carousel card. The read goes through the SSRF-safe
 * `fetchPublicHtml` (see `lib/link-preview.ts`); an unreadable page comes
 * back `isReadable: false` so the card is left for the user to fill.
 */
@Injectable()
export class LinkPreviewService {
  preview(url: string): Promise<LinkPreview> {
    return readLinkPreview(url);
  }
}
