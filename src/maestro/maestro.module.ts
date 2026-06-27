import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { QUEUES } from '../queue/queue.module';
import { UsersModule } from '../users/users.module';
import { WorkspaceModule } from '../workspace/workspace.module';
import { AiModule } from '../ai/ai.module';
// PostsModule exports PostService (publish/list drafts). It owns the heavy
// publish graph (BullMQ, publishers, channels) — import it rather than
// re-providing those deps.
import { PostsModule } from '../posts/posts.module';
// InboxModule exports InboxService — used so Maestro's DMs persist to the inbox
// (sent via the same path as a manual reply, fromMe=true).
import { InboxModule } from '../inbox/inbox.module';
import { MaestroController } from './maestro.controller';
import { MaestroService } from './services/maestro.service';
import { ClaudeAgentSdkRuntime } from './runtime/claude-agent-sdk.runtime';
// Reuse the existing chatbot conversation persistence (same DB tables).
// ConversationService + TokenTrackingService only depend on the global DRIZZLE provider.
import { ConversationService } from '../chatbot/services/conversation.service';
import { TokenTrackingService } from '../chatbot/services/token-tracking.service';
// Stock-media providers — both are dependency-free (config via env), so we
// provide them directly instead of importing their (heavier) home modules.
import { PexelsService } from '../pexels/pexels.service';
import { UnsplashService } from '../channels/services/unsplash.service';
// Discord REST client — stateless, env-config only (shared bot token), so it's
// safe to provide directly without pulling in the heavier ChannelsModule graph.
import { DiscordService } from '../channels/services/discord.service';
// Slack REST client — stateless, env-config only (per-workspace bot tokens are
// resolved + decrypted via InboxService). Provided directly like DiscordService.
import { SlackService } from '../channels/services/slack.service';
// Cloudflare R2 — S3-compatible, env-config only. Provided directly (it only
// needs ConfigService) so chat attachments can get presigned upload URLs
// without importing the heavier MediaModule graph.
import { CloudflareR2Service } from '../media/cloudflare-r2.service';
// Telegram REST client — env-config only (ConfigService); provided directly like
// DiscordService/SlackService to avoid pulling in the heavier ChannelsModule.
import { TelegramService } from '../channels/services/telegram.service';
// Maestro bridge (talk to Maestro from external channels). Providers declared
// here directly so the processor can use MaestroService without a forwardRef.
import { BridgeLinkService } from './bridge/services/bridge-link.service';
import { BridgeService } from './bridge/services/bridge.service';
import { MaestroBridgeProcessor } from './bridge/processors/maestro-bridge.processor';

@Module({
  imports: [
    ConfigModule,
    UsersModule,
    WorkspaceModule,
    AiModule,
    PostsModule,
    InboxModule,
    BullModule.registerQueue({ name: QUEUES.MAESTRO_BRIDGE }),
  ],
  controllers: [MaestroController],
  providers: [
    MaestroService,
    ClaudeAgentSdkRuntime,
    ConversationService,
    TokenTrackingService,
    PexelsService,
    UnsplashService,
    DiscordService,
    SlackService,
    CloudflareR2Service,
    TelegramService,
    BridgeLinkService,
    BridgeService,
    MaestroBridgeProcessor,
  ],
})
export class MaestroModule {}
