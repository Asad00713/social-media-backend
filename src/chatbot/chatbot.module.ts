import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DrizzleModule } from '../drizzle/drizzle.module';

// External modules (for tool dependencies)
import { UsersModule } from '../users/users.module';
import { WorkspaceModule } from '../workspace/workspace.module';
import { PostsModule } from '../posts/posts.module';
import { ChannelsModule } from '../channels/channels.module';
import { AiModule } from '../ai/ai.module';
import { PexelsModule } from '../pexels/pexels.module';
import { MediaLibraryModule } from '../media-library/media-library.module';

// External services (injected for tool factories)
import { UsersService } from '../users/users.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { PostService } from '../posts/services/post.service';
import { ChannelService } from '../channels/services/channel.service';
import { TavilyService } from '../ai/services/tavily.service';
import { UnsplashService } from '../channels/services/unsplash.service';
import { GoogleDriveService } from '../channels/services/google-drive.service';
import { OneDriveService } from '../channels/services/onedrive.service';
import { DropboxService } from '../channels/services/dropbox.service';
import { GooglePhotosService } from '../channels/services/google-photos.service';
import { PexelsService } from '../pexels/pexels.service';
import { MediaItemService } from '../media-library/services/media-item.service';

// Controller
import { ChatbotController } from './chatbot.controller';

// Main service
import { ChatbotService } from './chatbot.service';

// Sub-services
import { ConversationService } from './services/conversation.service';
import { ContextBuilderService } from './services/context-builder.service';
import { AgentService } from './services/agent.service';
import { TokenTrackingService } from './services/token-tracking.service';

// LLM
import { GroqChatProvider } from './llm/groq.provider';
import { ClaudeChatProvider } from './llm/claude.provider';
import { OpenAIChatProvider } from './llm/openai.provider';
import { GeminiChatProvider } from './llm/gemini.provider';
import { LLMRouterService } from './llm/llm-router.service';

// Guards
import { ChatbotRateLimitGuard } from './guards/chatbot-rate-limit.guard';

// Tools
import { ToolRegistryService } from './tools/tool-registry.service';
import { createUserTools } from './tools/user.tools';
import { createChannelTools } from './tools/channel.tools';
import { createPostTools } from './tools/post.tools';
import { createNavigationTools } from './tools/navigation.tools';
import { createWebSearchTools } from './tools/web-search.tools';
import { createStockImageTools } from './tools/stock-image.tools';
import { createCloudStorageTools } from './tools/cloud-storage.tools';
import { createMediaLibraryTools } from './tools/media-library.tools';
import { createMediaActionTools } from './tools/media-action.tools';

@Module({
  imports: [
    ConfigModule,
    DrizzleModule,
    UsersModule,
    WorkspaceModule,
    PostsModule,
    ChannelsModule,
    AiModule,
    PexelsModule,
    MediaLibraryModule,
  ],
  controllers: [ChatbotController],
  providers: [
    // Main orchestrator
    ChatbotService,

    // Services
    ConversationService,
    ContextBuilderService,
    AgentService,
    TokenTrackingService,

    // LLM providers
    GroqChatProvider,
    ClaudeChatProvider,
    OpenAIChatProvider,
    GeminiChatProvider,
    LLMRouterService,

    // Guards
    ChatbotRateLimitGuard,

    // Tool system
    ToolRegistryService,
  ],
  exports: [ChatbotService],
})
export class ChatbotModule implements OnModuleInit {
  private readonly logger = new Logger(ChatbotModule.name);

  constructor(
    private readonly toolRegistry: ToolRegistryService,
    private readonly usersService: UsersService,
    private readonly workspaceService: WorkspaceService,
    private readonly postService: PostService,
    private readonly channelService: ChannelService,
    private readonly tavilyService: TavilyService,
    private readonly unsplashService: UnsplashService,
    private readonly pexelsService: PexelsService,
    private readonly googleDriveService: GoogleDriveService,
    private readonly oneDriveService: OneDriveService,
    private readonly dropboxService: DropboxService,
    private readonly googlePhotosService: GooglePhotosService,
    private readonly mediaItemService: MediaItemService,
  ) {}

  onModuleInit() {
    this.toolRegistry.registerMany([
      ...createUserTools(this.usersService, this.workspaceService),
      ...createChannelTools(this.channelService),
      ...createPostTools(this.postService, this.channelService),
      ...createNavigationTools(),
      ...createWebSearchTools(this.tavilyService),
      ...createStockImageTools(this.unsplashService, this.pexelsService),
      ...createCloudStorageTools(
        this.channelService,
        this.googleDriveService,
        this.oneDriveService,
        this.dropboxService,
        this.googlePhotosService,
      ),
      ...createMediaLibraryTools(this.mediaItemService),
      ...createMediaActionTools(),
    ]);

    this.logger.log(`Registered ${this.toolRegistry.count} tools`);
  }
}
