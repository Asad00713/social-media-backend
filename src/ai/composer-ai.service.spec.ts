import { ComposerAiService } from './composer-ai.service';

describe('ComposerAiService', () => {
  describe('generatePerChannel', () => {
    it('generates one tailored caption per platform as a single billable unit', async () => {
      const groq = {
        buildCaptionPrompt: jest.fn((opts: any) => ({
          system: `system:${opts.platform}`,
          user: `user:${opts.platform}:${opts.tone ?? 'none'}`,
        })),
      } as any;

      const aiText = {
        complete: jest.fn((system: string) =>
          Promise.resolve(`caption-for-${system.replace('system:', '')}`),
        ),
      } as any;

      const aiTokens = {
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
      } as any;

      const service = new ComposerAiService(groq, aiText, aiTokens);

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

      // Tone threaded into every prompt build call.
      expect(groq.buildCaptionPrompt).toHaveBeenCalledTimes(3);
      for (const call of groq.buildCaptionPrompt.mock.calls) {
        expect(call[0]).toMatchObject({
          description: 'New product launch',
          tone: 'promotional',
          includeHashtags: true,
          includeCta: true,
        });
      }

      // Exactly one billable unit for the whole fan-out.
      expect(aiTokens.executeWithTokens).toHaveBeenCalledTimes(1);
      expect(aiTokens.executeWithTokens.mock.calls[0][2]).toBe(
        'generate_per_channel',
      );
      expect(aiTokens.executeWithTokens.mock.calls[0][0]).toBe('ws-1');
      expect(aiTokens.executeWithTokens.mock.calls[0][1]).toBe('user-1');
    });
  });
});
