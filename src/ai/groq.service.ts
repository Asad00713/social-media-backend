import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk';
import { SYSTEM_PROMPTS, USER_PROMPTS, PLATFORM_OPTIONS, TONE_OPTIONS } from './prompts';

export type Platform = (typeof PLATFORM_OPTIONS)[number];
export type Tone = (typeof TONE_OPTIONS)[number];

export interface GeneratePostOptions {
  topic: string;
  platform: Platform;
  tone?: Tone;
  additionalContext?: string;
}

export interface GenerateCaptionOptions {
  description: string;
  platform: Platform;
  tone?: Tone;
  includeHashtags?: boolean;
  includeCta?: boolean;
}

export interface GenerateHashtagsOptions {
  topic: string;
  platform: Platform;
  count?: number;
}

export interface GenerateIdeasOptions {
  niche: string;
  platform: Platform;
  count?: number;
  contentType?: string;
}

export interface GenerateYouTubeMetadataOptions {
  videoDescription: string;
  targetAudience?: string;
}

export interface YouTubeMetadataResult {
  title: string;
  description: string;
  tags: string[];
}

export interface RepurposeContentOptions {
  originalContent: string;
  sourcePlatform: Platform;
  targetPlatform: Platform;
}

export interface ImprovePostOptions {
  originalPost: string;
  platform: Platform;
  improvementFocus?: string;
}

export interface GenerateThreadOptions {
  topic: string;
  platform: 'twitter' | 'threads';
  postCount?: number;
}

export interface GenerateBioOptions {
  description: string;
  platform: Platform;
  keywords?: string[];
}

export interface TranslateContentOptions {
  content: string;
  targetLanguage: string;
  platform?: Platform;
}

export interface ContentIdea {
  title: string;
  description: string;
  format: string;
}

@Injectable()
export class GroqService {
  private readonly logger = new Logger(GroqService.name);
  private client: Groq | null = null;
  private readonly defaultModel = 'llama-3.3-70b-versatile';

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('GROQ_API_KEY');
    if (apiKey) {
      this.client = new Groq({ apiKey });
      this.logger.log('Groq client initialized');
    } else {
      this.logger.warn('GROQ_API_KEY not configured - AI features will be unavailable');
    }
  }

  /**
   * Check if the Groq service is ready
   */
  isReady(): boolean {
    return this.client !== null;
  }

  /**
   * Core method to generate completions
   */
  private async generateCompletion(
    systemPrompt: string,
    userPrompt: string,
    options?: {
      temperature?: number;
      maxTokens?: number;
      model?: string;
    },
  ): Promise<string> {
    if (!this.client) {
      throw new BadRequestException('Groq API is not configured');
    }

    const { temperature = 0.7, maxTokens = 1024, model = this.defaultModel } = options || {};

    try {
      const completion = await this.client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
        max_tokens: maxTokens,
      });

      const content = completion.choices[0]?.message?.content;
      if (!content) {
        throw new BadRequestException('No content generated');
      }

      return content.trim();
    } catch (error) {
      this.logger.error(`Groq API error: ${error}`);
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Failed to generate content');
    }
  }

  /**
   * Generate a social media post
   */
  async generatePost(options: GeneratePostOptions): Promise<string> {
    const { topic, platform, tone, additionalContext } = options;

    const userPrompt = USER_PROMPTS.generatePost(topic, platform, tone, additionalContext);

    return this.generateCompletion(SYSTEM_PROMPTS.contentGenerator, userPrompt);
  }

  /**
   * Generate a caption for media content
   */
  async generateCaption(options: GenerateCaptionOptions): Promise<string> {
    const { description, platform, tone, includeHashtags, includeCta } = options;

    const userPrompt = USER_PROMPTS.generateCaption(
      description,
      platform,
      tone,
      includeHashtags,
      includeCta,
    );

    return this.generateCompletion(SYSTEM_PROMPTS.captionWriter, userPrompt);
  }

  /**
   * Generate hashtags for a topic
   */
  async generateHashtags(options: GenerateHashtagsOptions): Promise<string[]> {
    const { topic, platform, count } = options;

    const userPrompt = USER_PROMPTS.generateHashtags(topic, platform, count);

    const result = await this.generateCompletion(SYSTEM_PROMPTS.hashtagGenerator, userPrompt);

    // Parse hashtags from the response
    const hashtags = result
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('#'))
      .map((tag) => (tag.includes(' ') ? tag.split(' ')[0] : tag));

    return hashtags;
  }

  /**
   * Generate content ideas
   */
  async generateIdeas(options: GenerateIdeasOptions): Promise<ContentIdea[]> {
    const { niche, platform, count, contentType } = options;

    const userPrompt = USER_PROMPTS.generateIdeas(niche, platform, count, contentType);

    const result = await this.generateCompletion(SYSTEM_PROMPTS.ideaGenerator, userPrompt, {
      maxTokens: 2048,
    });

    // Parse ideas from the response
    const ideas: ContentIdea[] = [];
    const lines = result.split('\n').filter((line) => line.trim());

    let currentIdea: Partial<ContentIdea> = {};
    for (const line of lines) {
      // Match numbered items like "1.", "2.", etc.
      const numberMatch = line.match(/^\d+\.\s*(.+)/);
      if (numberMatch) {
        if (currentIdea.title) {
          ideas.push(currentIdea as ContentIdea);
        }
        currentIdea = { title: numberMatch[1], description: '', format: '' };
      } else if (currentIdea.title) {
        // Check for format indicators
        if (line.toLowerCase().includes('format:')) {
          currentIdea.format = line.replace(/format:/i, '').trim();
        } else if (!currentIdea.description) {
          currentIdea.description = line.trim();
        }
      }
    }

    // Push the last idea
    if (currentIdea.title) {
      ideas.push(currentIdea as ContentIdea);
    }

    return ideas;
  }

  /**
   * Generate YouTube video metadata
   */
  async generateYouTubeMetadata(
    options: GenerateYouTubeMetadataOptions,
  ): Promise<YouTubeMetadataResult> {
    const { videoDescription, targetAudience } = options;

    const userPrompt = USER_PROMPTS.generateYouTubeMetadata(videoDescription, targetAudience);

    const result = await this.generateCompletion(SYSTEM_PROMPTS.contentGenerator, userPrompt, {
      maxTokens: 2048,
    });

    // Parse the structured response
    let title = '';
    let description = '';
    let tags: string[] = [];

    const lines = result.split('\n');
    let currentSection = '';

    for (const line of lines) {
      if (line.toUpperCase().startsWith('TITLE:')) {
        currentSection = 'title';
        title = line.replace(/TITLE:/i, '').trim();
      } else if (line.toUpperCase().startsWith('DESCRIPTION:')) {
        currentSection = 'description';
        description = line.replace(/DESCRIPTION:/i, '').trim();
      } else if (line.toUpperCase().startsWith('TAGS:')) {
        currentSection = 'tags';
        const tagsString = line.replace(/TAGS:/i, '').trim();
        tags = tagsString.split(',').map((tag) => tag.trim());
      } else if (currentSection === 'description' && line.trim()) {
        description += '\n' + line;
      }
    }

    return {
      title: title || 'Untitled Video',
      description: description || videoDescription,
      tags: tags.length > 0 ? tags : [],
    };
  }

  /**
   * Repurpose content from one platform to another
   */
  async repurposeContent(options: RepurposeContentOptions): Promise<string> {
    const { originalContent, sourcePlatform, targetPlatform } = options;

    const userPrompt = USER_PROMPTS.repurposeContent(
      originalContent,
      sourcePlatform,
      targetPlatform,
    );

    return this.generateCompletion(SYSTEM_PROMPTS.repurposer, userPrompt);
  }

  /**
   * Improve an existing post
   */
  async improvePost(options: ImprovePostOptions): Promise<string> {
    const { originalPost, platform, improvementFocus } = options;

    const userPrompt = USER_PROMPTS.improvePost(originalPost, platform, improvementFocus);

    return this.generateCompletion(SYSTEM_PROMPTS.contentGenerator, userPrompt);
  }

  /**
   * Generate a thread (Twitter/Threads)
   */
  async generateThread(options: GenerateThreadOptions): Promise<string[]> {
    const { topic, platform, postCount } = options;

    const userPrompt = USER_PROMPTS.generateThreadIdeas(topic, platform, postCount);

    const result = await this.generateCompletion(SYSTEM_PROMPTS.contentGenerator, userPrompt, {
      maxTokens: 2048,
    });

    // Parse thread posts from the response
    const posts: string[] = [];
    const lines = result.split('\n');
    let currentPost = '';

    for (const line of lines) {
      const numberMatch = line.match(/^\d+[\.\)]\s*/);
      if (numberMatch) {
        if (currentPost) {
          posts.push(currentPost.trim());
        }
        currentPost = line.replace(/^\d+[\.\)]\s*/, '');
      } else if (line.trim() && currentPost) {
        currentPost += ' ' + line.trim();
      }
    }

    if (currentPost) {
      posts.push(currentPost.trim());
    }

    return posts;
  }

  /**
   * Generate a social media bio
   */
  async generateBio(options: GenerateBioOptions): Promise<string> {
    const { description, platform, keywords } = options;

    const userPrompt = USER_PROMPTS.generateBio(description, platform, keywords);

    return this.generateCompletion(SYSTEM_PROMPTS.contentGenerator, userPrompt, {
      maxTokens: 256,
    });
  }

  /**
   * Translate content to another language
   */
  async translateContent(options: TranslateContentOptions): Promise<string> {
    const { content, targetLanguage, platform } = options;

    const userPrompt = USER_PROMPTS.translateContent(content, targetLanguage, platform);

    return this.generateCompletion(SYSTEM_PROMPTS.contentGenerator, userPrompt);
  }

  /**
   * Generate multiple variations of a post
   */
  async generateVariations(
    content: string,
    platform: Platform,
    count: number = 3,
  ): Promise<string[]> {
    const prompt = `Create ${count} different variations of this ${platform} post. Each should convey the same message but with different wording, structure, or approach.

Original post:
${content}

Provide ${count} variations, numbered 1 through ${count}. Each should be complete and ready to publish.`;

    const result = await this.generateCompletion(SYSTEM_PROMPTS.contentGenerator, prompt, {
      maxTokens: 2048,
    });

    // Parse variations
    const variations: string[] = [];
    const lines = result.split('\n');
    let currentVariation = '';

    for (const line of lines) {
      const numberMatch = line.match(/^\d+[\.\)]\s*/);
      if (numberMatch) {
        if (currentVariation) {
          variations.push(currentVariation.trim());
        }
        currentVariation = line.replace(/^\d+[\.\)]\s*/, '');
      } else if (line.trim() && currentVariation) {
        currentVariation += ' ' + line.trim();
      }
    }

    if (currentVariation) {
      variations.push(currentVariation.trim());
    }

    return variations.slice(0, count);
  }

  /**
   * Analyze a post for improvements
   */
  async analyzePost(
    content: string,
    platform: Platform,
  ): Promise<{
    score: number;
    strengths: string[];
    improvements: string[];
    suggestions: string;
  }> {
    const prompt = `Analyze this ${platform} post and provide feedback:

Post:
${content}

Provide your analysis in this exact format:
SCORE: [1-10]
STRENGTHS:
- [strength 1]
- [strength 2]
IMPROVEMENTS:
- [improvement 1]
- [improvement 2]
SUGGESTIONS: [A brief paragraph with specific suggestions to improve the post]`;

    const result = await this.generateCompletion(SYSTEM_PROMPTS.contentGenerator, prompt, {
      temperature: 0.5,
    });

    // Parse the analysis
    let score = 7;
    const strengths: string[] = [];
    const improvements: string[] = [];
    let suggestions = '';
    let currentSection = '';

    const lines = result.split('\n');
    for (const line of lines) {
      if (line.toUpperCase().startsWith('SCORE:')) {
        const scoreMatch = line.match(/\d+/);
        if (scoreMatch) {
          score = Math.min(10, Math.max(1, parseInt(scoreMatch[0])));
        }
      } else if (line.toUpperCase().startsWith('STRENGTHS:')) {
        currentSection = 'strengths';
      } else if (line.toUpperCase().startsWith('IMPROVEMENTS:')) {
        currentSection = 'improvements';
      } else if (line.toUpperCase().startsWith('SUGGESTIONS:')) {
        currentSection = 'suggestions';
        suggestions = line.replace(/SUGGESTIONS:/i, '').trim();
      } else if (line.trim().startsWith('-')) {
        const item = line.replace(/^-\s*/, '').trim();
        if (currentSection === 'strengths') {
          strengths.push(item);
        } else if (currentSection === 'improvements') {
          improvements.push(item);
        }
      } else if (currentSection === 'suggestions' && line.trim()) {
        suggestions += ' ' + line.trim();
      }
    }

    return { score, strengths, improvements, suggestions: suggestions.trim() };
  }
}
