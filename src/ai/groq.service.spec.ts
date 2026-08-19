import { ConfigService } from '@nestjs/config';
import { GroqService } from './groq.service';

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
