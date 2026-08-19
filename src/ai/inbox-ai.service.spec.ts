import { InboxAiService } from './inbox-ai.service';

describe('InboxAiService.suggestReply', () => {
  it('builds a prompt from the conversation and returns the reply + usage', async () => {
    const aiText = {
      complete: jest.fn().mockResolvedValue('Thanks for reaching out! ...'),
    } as any;
    const aiTokens = {
      executeWithTokens: jest.fn(
        async (
          _ws: string,
          _u: string,
          _op: string,
          _p: string | undefined,
          _s: string,
          fn: () => Promise<{ result: unknown; outputLength?: number }>,
        ) => {
          const { result } = await fn();
          return { result, usage: { tokensDeducted: 5, tokensRemaining: 95 } };
        },
      ),
    } as any;

    const service = new InboxAiService(aiText, aiTokens);
    const out = await service.suggestReply('ws-1', 'user-1', {
      platform: 'instagram',
      messages: [{ author: 'customer', text: 'Do you ship to the US?' }],
      instruction: 'suggest',
    });

    expect(out.reply).toContain('Thanks for reaching out');
    expect(out.usage.tokensDeducted).toBe(5);
    // The prompt handed to the model includes the conversation + platform.
    const [, userPrompt] = aiText.complete.mock.calls[0];
    expect(userPrompt).toContain('Do you ship to the US?');
    expect(userPrompt).toContain('instagram');
  });
});
