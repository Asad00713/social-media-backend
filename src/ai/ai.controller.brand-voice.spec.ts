import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  BrandVoiceService,
  EMPTY_PROMPT_SOURCE,
} from '../brand-voice/brand-voice.service';
import type { BrandVoiceFields } from '../brand-voice/brand-voice.types';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import { AiController } from './ai.controller';
import { ComposerAiService } from './composer-ai.service';
import type {
  GenerateCaptionDto,
  GenerateHashtagsDto,
  ImprovePostDto,
  RepurposeContentDto,
  TranslateContentDto,
} from './dto/ai.dto';
import {
  GroqService,
  type GenerateCaptionOptions,
  type ImprovePostOptions,
  type RepurposeContentOptions,
} from './groq.service';
import { InboxAiService } from './inbox-ai.service';
import { AiTokenService } from './services/ai-token.service';
import { ElevenLabsSttService } from './services/elevenlabs-stt.service';

const WS = '11111111-1111-4111-8111-111111111111';
const USER = { userId: 'user-1' };

const WARM_VOICE: BrandVoiceFields = {
  ...EMPTY_PROMPT_SOURCE.voice,
  tone: ['Warm'],
  description: 'We sell tea.',
  hashtagsMode: 'few',
  channelTweaks: { twitter: 'Keep it short.', linkedin: 'Add a takeaway.' },
};

describe('AiController brand voice', () => {
  let controller: AiController;
  const groq = {
    generateCaption: jest.fn<Promise<string>, [GenerateCaptionOptions]>(() =>
      Promise.resolve('caption'),
    ),
    improvePost: jest.fn<Promise<string>, [ImprovePostOptions]>(() =>
      Promise.resolve('improved'),
    ),
    repurposeContent: jest.fn<Promise<string>, [RepurposeContentOptions]>(() =>
      Promise.resolve('repurposed'),
    ),
    translateContent: jest.fn(() => Promise.resolve('translated')),
    generateHashtags: jest.fn(() => Promise.resolve(['#a'])),
  };
  // Runs the operation the way the real metering wrapper does.
  const executeWithTokens = jest.fn(
    async (
      _w: string,
      _u: string,
      _op: string,
      _p: string | undefined,
      _s: string,
      fn: () => Promise<{ result: unknown }>,
    ) => ({ result: (await fn()).result, usage: {} }),
  );
  const loadPromptSource = jest.fn();

  function voiceIs(voice: BrandVoiceFields | null) {
    loadPromptSource.mockImplementation(() =>
      Promise.resolve({
        voice: voice ?? { ...EMPTY_PROMPT_SOURCE.voice },
        savedHashtags: [],
      }),
    );
  }

  function captionOptions(): GenerateCaptionOptions {
    return groq.generateCaption.mock.calls[0][0];
  }

  const captionDto = (extra: Partial<GenerateCaptionDto> = {}) =>
    ({
      description: 'Launch',
      platform: 'twitter',
      ...extra,
    }) as GenerateCaptionDto;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AiController],
      providers: [
        WorkspaceRoleGuard,
        {
          provide: WorkspaceRoleService,
          useValue: { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() },
        },
        { provide: GroqService, useValue: groq },
        { provide: AiTokenService, useValue: { executeWithTokens } },
        { provide: ElevenLabsSttService, useValue: {} },
        { provide: ComposerAiService, useValue: {} },
        { provide: InboxAiService, useValue: {} },
        { provide: BrandVoiceService, useValue: { loadPromptSource } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = moduleRef.get(AiController);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    voiceIs(WARM_VOICE);
  });

  it('generateCaption passes the voice for its platform', async () => {
    await controller.generateCaption(WS, USER, captionDto());

    const { voice } = captionOptions();
    expect(voice).toContain('Warm');
    expect(voice).toContain('Keep it short.');
    expect(voice).not.toContain('Add a takeaway.');
    expect(loadPromptSource).toHaveBeenCalledTimes(1);
    expect(loadPromptSource).toHaveBeenCalledWith(WS);
    // Read before metering: a voice read is never charged.
    expect(loadPromptSource.mock.invocationCallOrder[0]).toBeLessThan(
      executeWithTokens.mock.invocationCallOrder[0],
    );
  });

  it('generateCaption lets the voice turn hashtags on when the request did not say', async () => {
    await controller.generateCaption(WS, USER, captionDto());
    expect(captionOptions().includeHashtags).toBe(true);
  });

  it('generateCaption lets the voice turn hashtags off when the request did not say', async () => {
    voiceIs({ ...WARM_VOICE, hashtagsMode: 'none' });
    await controller.generateCaption(WS, USER, captionDto());
    expect(captionOptions().includeHashtags).toBe(false);
  });

  it('generateCaption leaves includeHashtags undefined for a voice with no hashtag choice', async () => {
    voiceIs({ ...WARM_VOICE, hashtagsMode: null });
    await controller.generateCaption(WS, USER, captionDto());
    expect(captionOptions().includeHashtags).toBeUndefined();
    expect(captionOptions().voice).toContain('Warm');
    expect(captionOptions().voice).not.toContain('Hashtags');
  });

  it('generateCaption keeps an explicit includeHashtags: false', async () => {
    await controller.generateCaption(
      WS,
      USER,
      captionDto({ includeHashtags: false }),
    );
    expect(captionOptions().includeHashtags).toBe(false);
  });

  it('generateCaption with no voice passes includeHashtags undefined and voice ""', async () => {
    voiceIs(null);
    await controller.generateCaption(WS, USER, captionDto());
    expect(captionOptions().includeHashtags).toBeUndefined();
    expect(captionOptions().voice).toBe('');
  });

  it('improvePost and repurposeContent pass the voice (repurpose for the target platform)', async () => {
    await controller.improvePost(WS, USER, {
      originalPost: 'post',
      platform: 'linkedin',
    } as ImprovePostDto);
    const improve = groq.improvePost.mock.calls[0][0];
    expect(improve.voice).toContain('Add a takeaway.');
    expect(improve.voice).not.toContain('Keep it short.');

    await controller.repurposeContent(WS, USER, {
      originalContent: 'text',
      sourcePlatform: 'linkedin',
      targetPlatform: 'twitter',
    } as RepurposeContentDto);
    const repurpose = groq.repurposeContent.mock.calls[0][0];
    expect(repurpose.voice).toContain('Keep it short.');
    expect(repurpose.voice).not.toContain('Add a takeaway.');
    expect(loadPromptSource).toHaveBeenCalledTimes(2);
  });

  it('translateContent and generateHashtags never read the brand voice', async () => {
    await controller.translateContent(WS, USER, {
      content: 'hello',
      targetLanguage: 'French',
      platform: 'twitter',
    } as TranslateContentDto);
    await controller.generateHashtags(WS, USER, {
      topic: 'tea',
      platform: 'twitter',
    } as GenerateHashtagsDto);
    expect(loadPromptSource).not.toHaveBeenCalled();
    expect(groq.translateContent).toHaveBeenCalledTimes(1);
    expect(groq.generateHashtags).toHaveBeenCalledTimes(1);
  });
});
