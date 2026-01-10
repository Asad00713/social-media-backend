import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiController } from './ai.controller';
import { GroqService } from './groq.service';
import { TavilyService } from './services/tavily.service';
import { DripContentGeneratorService } from './services/drip-content-generator.service';

@Module({
  imports: [ConfigModule],
  controllers: [AiController],
  providers: [GroqService, TavilyService, DripContentGeneratorService],
  exports: [GroqService, TavilyService, DripContentGeneratorService],
})
export class AiModule {}
