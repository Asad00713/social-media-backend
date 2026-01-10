import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GroqService } from './groq.service';
import {
  GeneratePostDto,
  GenerateCaptionDto,
  GenerateHashtagsDto,
  GenerateIdeasDto,
  GenerateYouTubeMetadataDto,
  RepurposeContentDto,
  ImprovePostDto,
  GenerateThreadDto,
  GenerateBioDto,
  TranslateContentDto,
  GenerateVariationsDto,
  AnalyzePostDto,
  PLATFORMS,
  TONES,
} from './dto/ai.dto';

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(private readonly groqService: GroqService) {}

  /**
   * Check if AI service is configured and ready
   */
  @Get('status')
  @HttpCode(HttpStatus.OK)
  getStatus() {
    return {
      configured: this.groqService.isReady(),
      message: this.groqService.isReady()
        ? 'AI service is configured and ready'
        : 'AI service is not configured - check GROQ_API_KEY environment variable',
      model: 'llama-3.3-70b-versatile',
    };
  }

  /**
   * Get available platforms and tones
   */
  @Get('options')
  @HttpCode(HttpStatus.OK)
  getOptions() {
    return {
      platforms: PLATFORMS,
      tones: TONES,
    };
  }

  /**
   * Generate a social media post
   */
  @Post('generate/post')
  @HttpCode(HttpStatus.OK)
  async generatePost(@Body() dto: GeneratePostDto) {
    const content = await this.groqService.generatePost({
      topic: dto.topic,
      platform: dto.platform,
      tone: dto.tone,
      additionalContext: dto.additionalContext,
    });

    return { content };
  }

  /**
   * Generate a caption for media content
   */
  @Post('generate/caption')
  @HttpCode(HttpStatus.OK)
  async generateCaption(@Body() dto: GenerateCaptionDto) {
    const content = await this.groqService.generateCaption({
      description: dto.description,
      platform: dto.platform,
      tone: dto.tone,
      includeHashtags: dto.includeHashtags,
      includeCta: dto.includeCta,
    });

    return { content };
  }

  /**
   * Generate hashtags for a topic
   */
  @Post('generate/hashtags')
  @HttpCode(HttpStatus.OK)
  async generateHashtags(@Body() dto: GenerateHashtagsDto) {
    const hashtags = await this.groqService.generateHashtags({
      topic: dto.topic,
      platform: dto.platform,
      count: dto.count,
    });

    return { hashtags };
  }

  /**
   * Generate content ideas
   */
  @Post('generate/ideas')
  @HttpCode(HttpStatus.OK)
  async generateIdeas(@Body() dto: GenerateIdeasDto) {
    const ideas = await this.groqService.generateIdeas({
      niche: dto.niche,
      platform: dto.platform,
      count: dto.count,
      contentType: dto.contentType,
    });

    return { ideas };
  }

  /**
   * Generate YouTube video metadata (title, description, tags)
   */
  @Post('generate/youtube-metadata')
  @HttpCode(HttpStatus.OK)
  async generateYouTubeMetadata(@Body() dto: GenerateYouTubeMetadataDto) {
    const metadata = await this.groqService.generateYouTubeMetadata({
      videoDescription: dto.videoDescription,
      targetAudience: dto.targetAudience,
    });

    return metadata;
  }

  /**
   * Repurpose content from one platform to another
   */
  @Post('repurpose')
  @HttpCode(HttpStatus.OK)
  async repurposeContent(@Body() dto: RepurposeContentDto) {
    const content = await this.groqService.repurposeContent({
      originalContent: dto.originalContent,
      sourcePlatform: dto.sourcePlatform,
      targetPlatform: dto.targetPlatform,
    });

    return { content };
  }

  /**
   * Improve an existing post
   */
  @Post('improve')
  @HttpCode(HttpStatus.OK)
  async improvePost(@Body() dto: ImprovePostDto) {
    const content = await this.groqService.improvePost({
      originalPost: dto.originalPost,
      platform: dto.platform,
      improvementFocus: dto.improvementFocus,
    });

    return { content };
  }

  /**
   * Generate a thread (Twitter/Threads)
   */
  @Post('generate/thread')
  @HttpCode(HttpStatus.OK)
  async generateThread(@Body() dto: GenerateThreadDto) {
    const posts = await this.groqService.generateThread({
      topic: dto.topic,
      platform: dto.platform,
      postCount: dto.postCount,
    });

    return { posts };
  }

  /**
   * Generate a social media bio
   */
  @Post('generate/bio')
  @HttpCode(HttpStatus.OK)
  async generateBio(@Body() dto: GenerateBioDto) {
    const content = await this.groqService.generateBio({
      description: dto.description,
      platform: dto.platform,
      keywords: dto.keywords,
    });

    return { content };
  }

  /**
   * Translate content to another language
   */
  @Post('translate')
  @HttpCode(HttpStatus.OK)
  async translateContent(@Body() dto: TranslateContentDto) {
    const content = await this.groqService.translateContent({
      content: dto.content,
      targetLanguage: dto.targetLanguage,
      platform: dto.platform,
    });

    return { content };
  }

  /**
   * Generate multiple variations of a post
   */
  @Post('generate/variations')
  @HttpCode(HttpStatus.OK)
  async generateVariations(@Body() dto: GenerateVariationsDto) {
    const variations = await this.groqService.generateVariations(
      dto.content,
      dto.platform,
      dto.count,
    );

    return { variations };
  }

  /**
   * Analyze a post and get improvement suggestions
   */
  @Post('analyze')
  @HttpCode(HttpStatus.OK)
  async analyzePost(@Body() dto: AnalyzePostDto) {
    const analysis = await this.groqService.analyzePost(dto.content, dto.platform);

    return analysis;
  }
}
