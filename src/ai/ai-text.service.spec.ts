import { AiTextService } from './ai-text.service';

describe('AiTextService', () => {
  it('uses Gemini when it succeeds', async () => {
    const gemini = {
      isAvailable: () => true,
      generateText: jest.fn().mockResolvedValue('G'),
    } as any;
    const groq = { isReady: () => true, completeRaw: jest.fn() } as any;
    const svc = new AiTextService(gemini, groq);
    await expect(svc.complete('s', 'u')).resolves.toBe('G');
    expect(groq.completeRaw).not.toHaveBeenCalled();
  });

  it('falls back to Groq when Gemini throws', async () => {
    const gemini = {
      isAvailable: () => true,
      generateText: jest.fn().mockRejectedValue(new Error('rl')),
    } as any;
    const groq = {
      isReady: () => true,
      completeRaw: jest.fn().mockResolvedValue('Q'),
    } as any;
    const svc = new AiTextService(gemini, groq);
    await expect(svc.complete('s', 'u')).resolves.toBe('Q');
  });

  it('rejects when both Gemini and Groq are unavailable', async () => {
    const gemini = {
      isAvailable: () => false,
      generateText: jest.fn(),
    } as any;
    const groq = { isReady: () => false, completeRaw: jest.fn() } as any;
    const svc = new AiTextService(gemini, groq);
    await expect(svc.complete('s', 'u')).rejects.toThrow();
    expect(gemini.generateText).not.toHaveBeenCalled();
    expect(groq.completeRaw).not.toHaveBeenCalled();
  });

  describe('isReady', () => {
    it('is true when Gemini is available', () => {
      const gemini = { isAvailable: () => true } as any;
      const groq = { isReady: () => false } as any;
      expect(new AiTextService(gemini, groq).isReady()).toBe(true);
    });

    it('is true when Groq is ready', () => {
      const gemini = { isAvailable: () => false } as any;
      const groq = { isReady: () => true } as any;
      expect(new AiTextService(gemini, groq).isReady()).toBe(true);
    });

    it('is false when neither is available', () => {
      const gemini = { isAvailable: () => false } as any;
      const groq = { isReady: () => false } as any;
      expect(new AiTextService(gemini, groq).isReady()).toBe(false);
    });
  });
});
