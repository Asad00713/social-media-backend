import { Injectable, Logger } from '@nestjs/common';
import { InboxService } from '../inbox.service';
import { ChannelService } from '../../channels/services/channel.service';
import { WhatsAppService } from '../../channels/services/whatsapp.service';
import { CloudflareR2Service } from '../../media/cloudflare-r2.service';
import { parseWhatsAppMessages } from '../../channels/services/whatsapp-webhook.util';

@Injectable()
export class WhatsAppIngestService {
  private readonly logger = new Logger(WhatsAppIngestService.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly channelService: ChannelService,
    private readonly whatsapp: WhatsAppService,
    private readonly r2: CloudflareR2Service,
  ) {}

  async ingest(payload: any): Promise<void> {
    for (const m of parseWhatsAppMessages(payload)) {
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

      const base = {
        workspaceId: channel.workspaceId,
        channelId: channel.id,
        platform: 'whatsapp' as const,
        conversationId: `${m.phoneNumberId}:${m.fromWaId}`,
        platformItemId: m.messageId,
        authorPlatformId: m.fromWaId,
        authorHandle: m.fromWaId ? `+${m.fromWaId}` : undefined,
        authorDisplayName: m.authorName ?? `+${m.fromWaId}`,
        fromMe: false,
        platformCreatedAt: m.timestamp,
        metadata: m.referral ? { referral: m.referral } : undefined,
      };

      if (m.media) {
        try {
          const accessToken = await this.channelService.getAccessToken(
            channel.id,
            channel.workspaceId,
          );
          const { buffer, contentType } = await this.whatsapp.downloadMedia(
            accessToken,
            m.media.mediaId,
          );
          // No 'audio' R2 kind — audio shares the 'voice' prefix/limits.
          const r2Kind =
            m.media.kind === 'audio' ? 'voice' : m.media.kind;
          const { publicUrl } = await this.r2.uploadBuffer({
            kind: r2Kind,
            workspaceId: channel.workspaceId,
            buffer,
            contentType: m.media.mimeType ?? contentType,
            filename: m.media.filename ?? `whatsapp-${m.media.mediaId}`,
          });
          await this.inbox.upsertDm({
            ...base,
            text: m.media.caption ?? '',
            attachments: [
              {
                kind: m.media.kind,
                url: publicUrl,
                contentType: m.media.mimeType ?? contentType,
              },
            ],
          });
        } catch (err) {
          this.logger.warn(
            `WhatsApp media rehost failed for ${m.messageId}: ${(err as Error).message}`,
          );
          await this.inbox.upsertDm({
            ...base,
            text: m.media.caption || '[media unavailable]',
          });
        }
      } else if (m.note) {
        await this.inbox.upsertDm({ ...base, text: m.note });
      } else if (m.isText) {
        await this.inbox.upsertDm({ ...base, text: m.text });
      }
    }
  }
}
