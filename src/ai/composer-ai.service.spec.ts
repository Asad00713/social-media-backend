import {
  BrandVoiceService,
  EMPTY_PROMPT_SOURCE,
} from '../brand-voice/brand-voice.service';
import type { BrandVoiceFields } from '../brand-voice/brand-voice.types';
import { AiTextService } from './ai-text.service';
import { ComposerAiService } from './composer-ai.service';
import {
  GroqService,
  type GenerateCaptionOptions,
  type GenerateCaptionVariantsOptions,
} from './groq.service';
import { AiTokenService } from './services/ai-token.service';

const WARM_VOICE: BrandVoiceFields = {
  ...EMPTY_PROMPT_SOURCE.voice,
  tone: ['Warm'],
  description: 'We sell tea.',
  channelTweaks: { twitter: 'Keep it short.', linkedin: 'Add a takeaway.' },
};

type Prompt = { system: string; user: string };

/** Runs the metered operation the way the real wrapper does. */
function meteredTokens() {
  return {
    executeWithTokens: jest.fn(
      async (
        _workspaceId: string,
        _userId: string,
        _operation: string,
        _platform: string | undefined,
        _inputSummary: string,
        fn: () => Promise<{ result: unknown; outputLength?: number }>,
      ) => {
        const { result } = await fn();
        return { result, usage: { tokensDeducted: 8, tokensRemaining: 92 } };
      },
    ),
  };
}

function stubVoice(voice: BrandVoiceFields | null) {
  return {
    loadPromptSource: jest.fn(() =>
      Promise.resolve({
        voice: voice ?? { ...EMPTY_PROMPT_SOURCE.voice },
        savedHashtags: [],
      }),
    ),
  };
}

function perChannelService(opts: {
  voice: BrandVoiceFields | null;
  aiText?: (system: string) => Promise<string>;
  buildSystem?: (o: GenerateCaptionOptions) => string;
}) {
  const buildSystem = opts.buildSystem ?? (() => 's');
  const groq = {
    buildCaptionPrompt: jest.fn<Prompt, [GenerateCaptionOptions]>((o) => ({
      system: buildSystem(o),
      user: `user:${o.platform}:${o.tone ?? 'none'}`,
    })),
  };
  const aiText = {
    complete: jest.fn(opts.aiText ?? (() => Promise.resolve('text'))),
  };
  const aiTokens = meteredTokens();
  const brandVoice = stubVoice(opts.voice);
  const service = new ComposerAiService(
    groq as unknown as GroqService,
    aiText as unknown as AiTextService,
    aiTokens as unknown as AiTokenService,
    brandVoice as unknown as BrandVoiceService,
  );
  return { service, groq, aiText, aiTokens, brandVoice };
}

describe('ComposerAiService', () => {
  describe('generatePerChannel', () => {
    it('generates one tailored caption per platform as a single billable unit', async () => {
      const { service, groq, aiTokens } = perChannelService({
        voice: null,
        buildSystem: (o) => `system:${o.platform}`,
        aiText: (system) =>
          Promise.resolve(`caption-for-${system.replace('system:', '')}`),
      });

      const output = await service.generatePerChannel('ws-1', 'user-1', {
        description: 'New product launch',
        platforms: ['twitter', 'linkedin', 'instagram'],
        tone: 'promotional',
        includeHashtags: true,
      });

      expect(output.variations).toEqual([
        { platform: 'twitter', text: 'caption-for-twitter' },
        { platform: 'linkedin', text: 'caption-for-linkedin' },
        { platform: 'instagram', text: 'caption-for-instagram' },
      ]);
      expect(output.usage).toEqual({ tokensDeducted: 8, tokensRemaining: 92 });

      // Tone threaded into every prompt build call; no voice set, so ''.
      expect(groq.buildCaptionPrompt).toHaveBeenCalledTimes(3);
      for (const call of groq.buildCaptionPrompt.mock.calls) {
        expect(call[0]).toMatchObject({
          description: 'New product launch',
          tone: 'promotional',
          includeHashtags: true,
          includeCta: true,
          voice: '',
        });
      }

      // Exactly one billable unit for the whole fan-out.
      expect(aiTokens.executeWithTokens).toHaveBeenCalledTimes(1);
      const call = aiTokens.executeWithTokens.mock.calls[0];
      expect(call[2]).toBe('generate_per_channel');
      expect(call[0]).toBe('ws-1');
      expect(call[1]).toBe('user-1');
    });

    it('gives each platform its own block', async () => {
      const { service, groq, aiTokens, brandVoice } = perChannelService({
        voice: WARM_VOICE,
      });

      await service.generatePerChannel('ws-1', 'user-1', {
        description: 'Launch',
        platforms: ['twitter', 'linkedin', 'instagram'],
      });

      // One read for the whole fan-out, before the metered call.
      expect(brandVoice.loadPromptSource).toHaveBeenCalledTimes(1);
      expect(brandVoice.loadPromptSource).toHaveBeenCalledWith('ws-1');
      expect(
        brandVoice.loadPromptSource.mock.invocationCallOrder[0],
      ).toBeLessThan(aiTokens.executeWithTokens.mock.invocationCallOrder[0]);
      const [twitter, linkedin, instagram] =
        groq.buildCaptionPrompt.mock.calls.map((c) => c[0].voice ?? '');
      expect(twitter).toContain('Keep it short.');
      expect(twitter).not.toContain('Add a takeaway.');
      expect(linkedin).toContain('Add a takeaway.');
      expect(linkedin).not.toContain('Keep it short.');
      expect(instagram).toContain('Warm');
      expect(instagram).not.toContain('Keep it short.');
      expect(instagram).not.toContain('Add a takeaway.');
    });

    describe('hashtags', () => {
      const run = async (
        voice: BrandVoiceFields | null,
        includeHashtags?: boolean,
      ) => {
        const { service, groq } = perChannelService({ voice });
        await service.generatePerChannel('ws-1', 'user-1', {
          description: 'Launch',
          platforms: ['twitter', 'linkedin'],
          includeHashtags,
        });
        return groq.buildCaptionPrompt.mock.calls.map(
          (c) => c[0].includeHashtags,
        );
      };

      it('a voice that wants hashtags turns them on when the request did not say', async () => {
        expect(await run({ ...WARM_VOICE, hashtagsMode: 'few' })).toEqual([
          true,
          true,
        ]);
      });

      it('a voice with hashtags none keeps them off', async () => {
        expect(await run({ ...WARM_VOICE, hashtagsMode: 'none' })).toEqual([
          false,
          false,
        ]);
      });

      it('an explicit false wins over the voice', async () => {
        expect(
          await run({ ...WARM_VOICE, hashtagsMode: 'many' }, false),
        ).toEqual([false, false]);
      });

      it('with no voice nothing changes: hashtags stay off unless asked', async () => {
        const off = await run(null);
        expect(off.every((v) => !v)).toBe(true);
        expect(await run(null, true)).toEqual([true, true]);
      });
    });
  });

  describe('generateCaptionVariants', () => {
    function variantsService(voice: BrandVoiceFields | null) {
      const groq = {
        buildCaptionVariantsPrompt: jest.fn<
          Prompt,
          [GenerateCaptionVariantsOptions]
        >(() => ({ system: 's', user: 'u' })),
        parseNumberedList: jest.fn(() => ['a']),
      };
      const aiText = { complete: jest.fn(() => Promise.resolve('1. a')) };
      const aiTokens = meteredTokens();
      const brandVoice = stubVoice(voice);
      const service = new ComposerAiService(
        groq as unknown as GroqService,
        aiText as unknown as AiTextService,
        aiTokens as unknown as AiTokenService,
        brandVoice as unknown as BrandVoiceService,
      );
      return { groq, aiTokens, brandVoice, service };
    }
    const input = {
      description: 'Launch',
      platform: 'twitter' as const,
      count: 1,
    };

    it('passes the voice', async () => {
      const { groq, aiTokens, brandVoice, service } =
        variantsService(WARM_VOICE);

      await service.generateCaptionVariants('ws-1', 'user-1', input);

      const { voice } = groq.buildCaptionVariantsPrompt.mock.calls[0][0];
      expect(voice).toContain('Warm');
      expect(voice).toContain('Keep it short.');
      expect(voice).not.toContain('Add a takeaway.');
      expect(brandVoice.loadPromptSource).toHaveBeenCalledTimes(1);
      // Read before metering, so a voice read is never charged.
      expect(
        brandVoice.loadPromptSource.mock.invocationCallOrder[0],
      ).toBeLessThan(aiTokens.executeWithTokens.mock.invocationCallOrder[0]);
    });

    it('passes an empty voice when the workspace has none', async () => {
      const { groq, service } = variantsService(null);
      await service.generateCaptionVariants('ws-1', 'user-1', input);
      expect(groq.buildCaptionVariantsPrompt.mock.calls[0][0].voice).toBe('');
    });
  });
});
