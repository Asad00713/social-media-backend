import { BadRequestException } from '@nestjs/common';
import { InboxAiService } from './inbox-ai.service';
import { loadReplyContext } from '../inbox/conversations/lib/reply-context';

jest.mock('../inbox/conversations/lib/reply-context', () => ({
  loadReplyContext: jest.fn(),
}));

const WS = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const COMMENT = '33333333-3333-4333-8333-333333333333';

function build(completion = 'Thanks for reaching out! ...') {
  const aiText = { complete: jest.fn().mockResolvedValue(completion) } as any;
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
  const db = {} as any;
  return {
    aiText,
    aiTokens,
    db,
    service: new InboxAiService(aiText, aiTokens, db),
  };
}

describe('InboxAiService.suggestReply', () => {
  beforeEach(() => jest.clearAllMocks());

  it('legacy body: builds a prompt from the passed messages', async () => {
    const { service, aiText } = build();
    const out = await service.suggestReply('ws-1', 'user-1', {
      platform: 'instagram',
      messages: [{ author: 'customer', text: 'Do you ship to the US?' }],
      instruction: 'suggest',
    });
    expect(out.reply).toContain('Thanks for reaching out');
    expect(out.usage.tokensDeducted).toBe(5);
    const [, userPrompt] = aiText.complete.mock.calls[0];
    expect(userPrompt).toContain('Do you ship to the US?');
    expect(userPrompt).toContain('instagram');
    expect(loadReplyContext).not.toHaveBeenCalled();
  });

  it('conversationId body: loads the context server-side (prompt comes from the DB rows)', async () => {
    (loadReplyContext as jest.Mock).mockResolvedValue({
      platform: 'facebook',
      messages: [{ author: 'customer', text: 'Loaded from the DB' }],
    });
    const { service, aiText, aiTokens, db } = build();
    const input: any = {
      conversationId: CONV,
      commentId: COMMENT,
      instruction: 'suggest',
    };
    await service.suggestReply(WS, 'user-1', input);
    expect(loadReplyContext).toHaveBeenCalledWith(db, WS, CONV, COMMENT);
    const [, userPrompt] = aiText.complete.mock.calls[0];
    expect(userPrompt).toContain('Loaded from the DB');
    expect(userPrompt).toContain('facebook');
    expect(aiTokens.executeWithTokens.mock.calls[0][3]).toBe('facebook');
  });

  it('translate_en builds the translate prompt from the draft', async () => {
    (loadReplyContext as jest.Mock).mockResolvedValue({
      platform: 'instagram',
      messages: [{ author: 'customer', text: 'hola' }],
    });
    const { service, aiText } = build();
    await service.suggestReply(WS, 'user-1', {
      conversationId: CONV,
      instruction: 'translate_en',
      draft: 'Gracias por escribir',
    });
    const [, userPrompt] = aiText.complete.mock.calls[0];
    expect(userPrompt).toContain(
      'Here is my current draft reply:\nGracias por escribir\n\nTranslate it into natural English, keeping the meaning and tone. If it is already English, return it unchanged.',
    );
  });

  it.each(['translate_en', 'rephrase', 'shorten', 'friendly'] as const)(
    '%s without a draft is a 400 and costs nothing',
    async (instruction) => {
      const { service, aiTokens } = build();
      await expect(
        service.suggestReply(WS, 'user-1', {
          conversationId: CONV,
          instruction,
          draft: '  ',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(aiTokens.executeWithTokens).not.toHaveBeenCalled();
    },
  );

  it('rejects both or neither of conversationId / messages', async () => {
    const { service } = build();
    await expect(
      service.suggestReply(WS, 'u', {
        conversationId: CONV,
        platform: 'x',
        messages: [{ author: 'customer', text: 'hi' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.suggestReply(WS, 'u', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('InboxAiService.quickReplies', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is metered as suggest_reply and returns 3 parsed replies', async () => {
    (loadReplyContext as jest.Mock).mockResolvedValue({
      platform: 'instagram',
      messages: [{ author: 'customer', text: 'Love this!' }],
    });
    const { service, aiText, aiTokens, db } = build(
      '["Thanks!","We will DM you","Glad you like it"]',
    );
    const out = await service.quickReplies(WS, 'user-1', {
      conversationId: CONV,
      commentId: COMMENT,
    });
    expect(out).toEqual({
      replies: ['Thanks!', 'We will DM you', 'Glad you like it'],
    });
    expect(loadReplyContext).toHaveBeenCalledWith(db, WS, CONV, COMMENT);
    const call = aiTokens.executeWithTokens.mock.calls[0];
    expect(call.slice(0, 5)).toEqual([
      WS,
      'user-1',
      'suggest_reply',
      'instagram',
      'Inbox quick replies on instagram',
    ]);
    const [, userPrompt] = aiText.complete.mock.calls[0];
    expect(userPrompt).toContain('Love this!');
    expect(userPrompt).toMatch(/exactly 3/);
    expect(userPrompt).toMatch(/60/);
  });
});
