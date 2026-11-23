import { ConfigService } from '@nestjs/config';
import { GroqService } from './groq.service';
import { SYSTEM_PROMPTS } from './prompts';

// Build a GroqService whose Groq client returns `content` for any completion,
// so we can exercise the real prompt-building + numbered-list parsing.
function makeService(content: string): GroqService {
  const config = {
    get: (key: string) => (key === 'GROQ_API_KEY' ? 'test-key' : undefined),
  } as unknown as ConfigService;

  const service = new GroqService(config);

  // Replace the SDK client with a stub returning our canned content.
  (service as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{ message: { content } }],
        }),
      },
    },
  };

  return service;
}

describe('GroqService.generateCaptionVariants', () => {
  it('parses a numbered list into separate captions, capped at count', async () => {
    const service = makeService(
      '1. First caption here\n2. Second caption here\n3. Third caption here',
    );

    const variants = await service.generateCaptionVariants({
      description: 'Announce our summer sale',
      platform: 'linkedin',
      count: 2,
    });

    expect(variants).toEqual(['First caption here', 'Second caption here']);
  });

  it('keeps multi-line captions together', async () => {
    const service = makeService(
      '1. Line one\ncontinued line\n2. Second caption',
    );

    const variants = await service.generateCaptionVariants({
      description: 'idea',
      platform: 'instagram',
      count: 2,
    });

    expect(variants).toEqual(['Line one\ncontinued line', 'Second caption']);
  });

  it('handles "1)" style numbering', async () => {
    const service = makeService('1) Alpha\n2) Beta');

    const variants = await service.generateCaptionVariants({
      description: 'idea',
      platform: 'twitter',
      count: 4,
    });

    expect(variants).toEqual(['Alpha', 'Beta']);
  });

  it('falls back to the whole response when the model ignores numbering', async () => {
    const service = makeService('Just a single unnumbered caption.');

    const variants = await service.generateCaptionVariants({
      description: 'idea',
      platform: 'facebook',
      count: 1,
    });

    expect(variants).toEqual(['Just a single unnumbered caption.']);
  });
});

describe('GroqService brand voice in the system prompt', () => {
  const VOICE = 'Brand voice:\n- Tone: warm.';
  const builders = [
    ['buildCaptionPrompt', SYSTEM_PROMPTS.captionWriter],
    ['buildCaptionVariantsPrompt', SYSTEM_PROMPTS.captionWriter],
    ['buildImprovePrompt', SYSTEM_PROMPTS.contentGenerator],
  ] as const;

  function build(name: (typeof builders)[number][0], voice?: string) {
    const service = makeService('');
    switch (name) {
      case 'buildCaptionPrompt':
        return service.buildCaptionPrompt({
          description: 'idea',
          platform: 'linkedin',
          voice,
        });
      case 'buildCaptionVariantsPrompt':
        return service.buildCaptionVariantsPrompt({
          description: 'idea',
          platform: 'linkedin',
          count: 2,
          voice,
        });
      default:
        return service.buildImprovePrompt({
          originalPost: 'post',
          platform: 'linkedin',
          voice,
        });
    }
  }

  it.each(builders)(
    '%s: no voice keeps the system constant exactly',
    (name, constant) => {
      expect(build(name).system).toBe(constant);
      expect(build(name, '').system).toBe(constant);
    },
  );

  it.each(builders)('%s appends the voice', (name, constant) => {
    expect(build(name, VOICE).system).toBe(`${constant}\n\n${VOICE}`);
  });

  it('repurposeContent sends the voice in the system prompt', async () => {
    const service = makeService('');
    const spy = jest
      .spyOn(
        service as unknown as {
          generateCompletion: (s: string, u: string) => Promise<string>;
        },
        'generateCompletion',
      )
      .mockResolvedValue('out');
    await service.repurposeContent({
      originalContent: 'text',
      sourcePlatform: 'linkedin',
      targetPlatform: 'twitter',
      voice: VOICE,
    });
    expect(spy.mock.calls[0][0]).toBe(
      `${SYSTEM_PROMPTS.repurposer}\n\n${VOICE}`,
    );
    await service.repurposeContent({
      originalContent: 'text',
      sourcePlatform: 'linkedin',
      targetPlatform: 'twitter',
    });
    expect(spy.mock.calls[1][0]).toBe(SYSTEM_PROMPTS.repurposer);
  });
});
