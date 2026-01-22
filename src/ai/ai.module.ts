import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiController } from './ai.controller';
import { GroqService } from './groq.service';
import { TavilyService } from './services/tavily.service';
import { DripContentGeneratorService } from './services/drip-content-generator.service';
import { AiTokenService } from './services/ai-token.service';
import { ElevenLabsSttService } from './services/elevenlabs-stt.service';
import { DrizzleModule } from '../drizzle/drizzle.module';

@Module({
  imports: [ConfigModule, DrizzleModule],
  controllers: [AiController],
  providers: [
    GroqService,
    TavilyService,
    DripContentGeneratorService,
    AiTokenService,
    ElevenLabsSttService,
  ],
  exports: [
    GroqService,
    TavilyService,
    DripContentGeneratorService,
    AiTokenService,
    ElevenLabsSttService,
  ],
})
export class AiModule {}
