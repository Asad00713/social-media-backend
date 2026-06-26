import { Injectable, Logger } from '@nestjs/common';
import { InboxService } from '../inbox.service';
import { parseWhatsAppMessages } from '../../channels/services/whatsapp-webhook.util';

@Injectable()
export class WhatsAppIngestService {
  private readonly logger = new Logger(WhatsAppIngestService.name);

  constructor(private readonly inbox: InboxService) {}

  async ingest(payload: any): Promise<void> {
    for (const m of parseWhatsAppMessages(payload)) {
      if (!m.isText) continue; // Phase 1: text only
      const channel = await this.inbox.findChannelByPlatformAccount(
        'whatsapp',
        m.phoneNumberId,
      );
      if (!channel) {
        this.logger.warn(
          `No whatsapp channel for phone_number_id=${m.phoneNumberId}; dropping message ${m.messageId}`,
        );
        continue;
      }
      await this.inbox.upsertDm({
        workspaceId: channel.workspaceId,
        channelId: channel.id,
        platform: 'whatsapp',
        conversationId: `${m.phoneNumberId}:${m.fromWaId}`,
        platformItemId: m.messageId,
        authorPlatformId: m.fromWaId,
        authorDisplayName: m.authorName ?? m.fromWaId,
        text: m.text,
        fromMe: false,
        platformCreatedAt: m.timestamp,
        metadata: m.referral ? { referral: m.referral } : undefined,
      });
    }
  }
}
