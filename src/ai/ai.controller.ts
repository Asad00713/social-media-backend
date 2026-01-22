import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { GroqService } from './groq.service';
import { AiTokenService, AI_OPERATION_COSTS } from './services/ai-token.service';
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
  constructor(
    private readonly groqService: GroqService,
    private readonly aiTokenService: AiTokenService,
  ) {}

  // ==========================================================================
  // Public endpoints (no workspace required)
  // ==========================================================================

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
   * Get available platforms, tones, and token costs
   */
  @Get('options')
  @HttpCode(HttpStatus.OK)
  getOptions() {
    return {
      platforms: PLATFORMS,
      tones: TONES,
      tokenCosts: AI_OPERATION_COSTS,
    };
  }

  /**
   * Get AI usage for a workspace
   */
  @Get('workspaces/:workspaceId/usage')
  @HttpCode(HttpStatus.OK)
  async getWorkspaceUsage(@Param('workspaceId') workspaceId: string) {
    const usage = await this.aiTokenService.getWorkspaceAiUsage(workspaceId);
    const recentLogs = await this.aiTokenService.getRecentUsageLogs(workspaceId, 10);

    return {
      tokens: usage,
      recentActivity: recentLogs.map((log) => ({
        operation: log.operation,
        tokensUsed: log.tokensUsed,
        platform: log.platform,
        user: log.user,
        createdAt: log.createdAt,
        success: log.success,
      })),
    };
  }

  // ==========================================================================
  // AI Generation endpoints (require workspace + tokens)
  // ==========================================================================

  /**
   * Generate a social media post
   */
  @Post('workspaces/:workspaceId/generate/post')
  @HttpCode(HttpStatus.OK)
  async generatePost(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: GeneratePostDto,
  ) {
    const { result, usage } = await this.aiTokenService.executeWithTokens(
      workspaceId,
      user.userId,
      'generate_post',
      dto.platform,
      `Post about: ${dto.topic.substring(0, 100)}`,
      async () => {
        const content = await this.groqService.generatePost({
          topic: dto.topic,
          platform: dto.platform,
          tone: dto.tone,
          additionalContext: dto.additionalContext,
        });
        return { result: content, outputLength: content.length };
      },
    );

    return { content: result, usage };
  }

  /**
   * Generate a caption for media content
   */
  @Post('workspaces/:workspaceId/generate/caption')
  @HttpCode(HttpStatus.OK)
  async generateCaption(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: GenerateCaptionDto,
  ) {
    const { result, usage } = await this.aiTokenService.executeWithTokens(
      workspaceId,
      user.userId,
      'generate_caption',
      dto.platform,
      `Caption for: ${dto.description.substring(0, 100)}`,
      async () => {
        const content = await this.groqService.generateCaption({
          description: dto.description,
          platform: dto.platform,
          tone: dto.tone,
          includeHashtags: dto.includeHashtags,
          includeCta: dto.includeCta,
        });
        return { result: content, outputLength: content.length };
      },
    );

    return { content: result, usage };
  }

  /**
   * Generate hashtags for a topic
   */
  @Post('workspaces/:workspaceId/generate/hashtags')
  @HttpCode(HttpStatus.OK)
  async generateHashtags(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: GenerateHashtagsDto,
  ) {
    const { result, usage } = await this.aiTokenService.executeWithTokens(
      workspaceId,
      user.userId,
      'generate_hashtags',
      dto.platform,
      `Hashtags for: ${dto.topic.substring(0, 100)}`,
      async () => {
        const hashtags = await this.groqService.generateHashtags({
          topic: dto.topic,
          platform: dto.platform,
          count: dto.count,
        });
        return { result: hashtags, outputLength: hashtags.join(' ').length };
      },
    );

    return { hashtags: result, usage };
  }

  /**
   * Generate content ideas
   */
  @Post('workspaces/:workspaceId/generate/ideas')
  @HttpCode(HttpStatus.OK)
  async generateIdeas(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: GenerateIdeasDto,
  ) {
    const { result, usage } = await this.aiTokenService.executeWithTokens(
      workspaceId,
      user.userId,
      'generate_ideas',
      dto.platform,
      `Ideas for niche: ${dto.niche.substring(0, 100)}`,
      async () => {
        const ideas = await this.groqService.generateIdeas({
          niche: dto.niche,
          platform: dto.platform,
          count: dto.count,
          contentType: dto.contentType,
        });
        return { result: ideas };
      },
    );

    return { ideas: result, usage };
  }

  /**
   * Generate YouTube video metadata (title, description, tags)
   */
  @Post('workspaces/:workspaceId/generate/youtube-metadata')
  @HttpCode(HttpStatus.OK)
  async generateYouTubeMetadata(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: GenerateYouTubeMetadataDto,
  ) {
    const { result, usage } = await this.aiTokenService.executeWithTokens(
      workspaceId,
      user.userId,
      'generate_youtube_metadata',
      'youtube',
      `YouTube metadata for: ${dto.videoDescription.substring(0, 100)}`,
      async () => {
        const metadata = await this.groqService.generateYouTubeMetadata({
          videoDescription: dto.videoDescription,
          targetAudience: dto.targetAudience,
        });
        return { result: metadata };
      },
    );

    return { ...result, usage };
  }

  /**
   * Repurpose content from one platform to another
   */
  @Post('workspaces/:workspaceId/repurpose')
  @HttpCode(HttpStatus.OK)
  async repurposeContent(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: RepurposeContentDto,
  ) {
    const { result, usage } = await this.aiTokenService.executeWithTokens(
      workspaceId,
      user.userId,
      'repurpose_content',
      dto.targetPlatform,
      `Repurpose from ${dto.sourcePlatform} to ${dto.targetPlatform}`,
      async () => {
        const content = await this.groqService.repurposeContent({
          originalContent: dto.originalContent,
          sourcePlatform: dto.sourcePlatform,
          targetPlatform: dto.targetPlatform,
        });
        return { result: content, outputLength: content.length };
      },
    );

    return { content: result, usage };
  }

  /**
   * Improve an existing post
   */
  @Post('workspaces/:workspaceId/improve')
  @HttpCode(HttpStatus.OK)
  async improvePost(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: ImprovePostDto,
  ) {
    const { result, usage } = await this.aiTokenService.executeWithTokens(
      workspaceId,
      user.userId,
      'improve_post',
      dto.platform,
      `Improve post: ${dto.originalPost.substring(0, 100)}`,
      async () => {
        const content = await this.groqService.improvePost({
          originalPost: dto.originalPost,
          platform: dto.platform,
          improvementFocus: dto.improvementFocus,
        });
        return { result: content, outputLength: content.length };
      },
    );

    return { content: result, usage };
  }

  /**
   * Generate a thread (Twitter/Threads)
   */
  @Post('workspaces/:workspaceId/generate/thread')
  @HttpCode(HttpStatus.OK)
  async generateThread(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: GenerateThreadDto,
  ) {
    const { result, usage } = await this.aiTokenService.executeWithTokens(
      workspaceId,
      user.userId,
      'generate_thread',
      dto.platform,
      `Thread about: ${dto.topic.substring(0, 100)}`,
      async () => {
        const posts = await this.groqService.generateThread({
          topic: dto.topic,
          platform: dto.platform,
          postCount: dto.postCount,
        });
        return { result: posts, outputLength: posts.join(' ').length };
      },
    );

    return { posts: result, usage };
  }

  /**
   * Generate a social media bio
   */
  @Post('workspaces/:workspaceId/generate/bio')
  @HttpCode(HttpStatus.OK)
  async generateBio(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: GenerateBioDto,
  ) {
    const { result, usage } = await this.aiTokenService.executeWithTokens(
      workspaceId,
      user.userId,
      'generate_bio',
      dto.platform,
      `Bio: ${dto.description.substring(0, 100)}`,
      async () => {
        const content = await this.groqService.generateBio({
          description: dto.description,
          platform: dto.platform,
          keywords: dto.keywords,
        });
        return { result: content, outputLength: content.length };
      },
    );

    return { content: result, usage };
  }

  /**
   * Translate content to another language
   */
  @Post('workspaces/:workspaceId/translate')
  @HttpCode(HttpStatus.OK)
  async translateContent(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: TranslateContentDto,
  ) {
    const { result, usage } = await this.aiTokenService.executeWithTokens(
      workspaceId,
      user.userId,
      'translate_content',
      dto.platform,
      `Translate to ${dto.targetLanguage}`,
      async () => {
        const content = await this.groqService.translateContent({
          content: dto.content,
          targetLanguage: dto.targetLanguage,
          platform: dto.platform,
        });
        return { result: content, outputLength: content.length };
      },
    );

    return { content: result, usage };
  }

  /**
   * Generate multiple variations of a post
   */
  @Post('workspaces/:workspaceId/generate/variations')
  @HttpCode(HttpStatus.OK)
  async generateVariations(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: GenerateVariationsDto,
  ) {
    const { result, usage } = await this.aiTokenService.executeWithTokens(
      workspaceId,
      user.userId,
      'generate_variations',
      dto.platform,
      `Variations of: ${dto.content.substring(0, 100)}`,
      async () => {
        const variations = await this.groqService.generateVariations(
          dto.content,
          dto.platform,
          dto.count,
        );
        return { result: variations, outputLength: variations.join(' ').length };
      },
    );

    return { variations: result, usage };
  }

  /**
   * Analyze a post and get improvement suggestions
   */
  @Post('workspaces/:workspaceId/analyze')
  @HttpCode(HttpStatus.OK)
  async analyzePost(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: AnalyzePostDto,
  ) {
    const { result, usage } = await this.aiTokenService.executeWithTokens(
      workspaceId,
      user.userId,
      'analyze_post',
      dto.platform,
      `Analyze post: ${dto.content.substring(0, 100)}`,
      async () => {
        const analysis = await this.groqService.analyzePost(dto.content, dto.platform);
        return { result: analysis };
      },
    );

    return { ...result, usage };
  }
}
