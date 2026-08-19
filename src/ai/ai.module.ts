import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiController } from './ai.controller';
import { GroqService } from './groq.service';
import { AiTextService } from './ai-text.service';
import { TavilyService } from './services/tavily.service';
import { DripContentGeneratorService } from './services/drip-content-generator.service';
import { AiTokenService } from './services/ai-token.service';
import { ElevenLabsSttService } from './services/elevenlabs-stt.service';
import { ComposerAiService } from './composer-ai.service';
import { InboxAiService } from './inbox-ai.service';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { GeminiChatProvider } from '../chatbot/llm/gemini.provider';

// GeminiChatProvider is provided here directly (not imported from
// ChatbotModule) to avoid a circular module dependency: ChatbotModule
// already imports AiModule, so AiModule importing ChatbotModule back would
// cycle. GeminiChatProvider's constructor only depends on ConfigService
// (already available via ConfigModule here), so instantiating a second,
// AiModule-scoped copy is cheap and side-effect-free.
@Module({
  imports: [ConfigModule, DrizzleModule],
  controllers: [AiController],
  providers: [
    GroqService,
    GeminiChatProvider,
    AiTextService,
    TavilyService,
    DripContentGeneratorService,
    AiTokenService,
    ElevenLabsSttService,
    ComposerAiService,
    InboxAiService,
  ],
  exports: [
    GroqService,
    AiTextService,
    TavilyService,
    DripContentGeneratorService,
    AiTokenService,
    ElevenLabsSttService,
    ComposerAiService,
    InboxAiService,
  ],
})
export class AiModule {}
