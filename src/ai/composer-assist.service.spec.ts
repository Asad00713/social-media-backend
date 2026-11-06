import { UnprocessableEntityException } from '@nestjs/common';

jest.mock('../media-library/lib/link-meta', () => ({
  fetchPublicHtml: jest.fn(),
  extractPageMeta: jest.fn(),
}));

import {
  extractPageMeta,
  fetchPublicHtml,
} from '../media-library/lib/link-meta';
import { ComposerAssistService } from './composer-assist.service';

const WS = 'ws-1';
const USER = 'user-1';

/** A drizzle stub whose selects resolve, in call order, to these rows. */
function dbReturning(...results: unknown[][]) {
  const queue = [...results];
  const chain: any = {
    select: jest.fn(() => chain),
    from: jest.fn(() => chain),
    where: jest.fn(() => chain),
    limit: jest.fn(() => Promise.resolve(queue.shift() ?? [])),
  };
  return chain;
}

function build(opts: { claudeReady?: boolean; db?: any } = {}) {
  // Both model clients are mocks: no test here reaches a live model.
  const claude = {
    isReady: jest.fn().mockReturnValue(opts.claudeReady ?? true),
    complete: jest.fn().mockResolvedValue('reply'),
  };
  const aiText = { complete: jest.fn().mockResolvedValue('fallback reply') };
  const aiTokens = {
    executeWithTokens: jest.fn(
      async (
        _ws: string,
        _u: string,
        _op: string,
        _p: unknown,
        _s: string,
        fn: () => Promise<{ result: unknown }>,
      ) => ({ result: (await fn()).result, usage: { tokensDeducted: 5 } }),
    ),
  };
  const db = opts.db ?? dbReturning([], []);
  const svc = new ComposerAssistService(
    claude as any,
    aiText as any,
    aiTokens as any,
    db,
  );
  return { svc, claude, aiText, aiTokens, db };
}

describe('ComposerAssistService', () => {
  afterEach(() => jest.clearAllMocks());

  describe('finishDraft', () => {
    it('keeps the draft byte for byte and appends the continuation', async () => {
      const { svc, claude, aiTokens } = build();
      claude.complete.mockResolvedValue('on Monday at the market.');
      const out = await svc.finishDraft(WS, USER, {
        caption: 'Our stall opens',
        platform: 'instagram',
      });
      expect(out.content).toBe('Our stall opens on Monday at the market.');
      expect(aiTokens.executeWithTokens.mock.calls[0][2]).toBe('finish_draft');
      expect(aiTokens.executeWithTokens.mock.calls[0][3]).toBe('instagram');
      // The draft is data in the user turn, never in the system prompt.
      expect(claude.complete.mock.calls[0][0]).not.toContain('Our stall opens');
      expect(claude.complete.mock.calls[0][1]).toContain('Our stall opens');
    });

    it('falls back to the shared text service when Claude is not configured', async () => {
      const { svc, claude, aiText } = build({ claudeReady: false });
      aiText.complete.mockResolvedValue('today.');
      const out = await svc.finishDraft(WS, USER, { caption: 'We open' });
      expect(out.content).toBe('We open today.');
      expect(claude.complete).not.toHaveBeenCalled();
    });
  });

  describe('fitChannels', () => {
    it('writes one caption per channel as ONE metered unit, flagging overruns', async () => {
      const { svc, claude, aiTokens } = build();
      claude.complete.mockImplementation(async (system: string) =>
        system.includes('X (Twitter)') ? 'x'.repeat(300) : 'Short LinkedIn.',
      );
      const out = await svc.fitChannels(WS, USER, {
        caption: 'A long shared caption',
        channels: [
          { platform: 'twitter', maxChars: 280 },
          { platform: 'linkedin', maxChars: 3000 },
        ],
      });
      expect(out.variations).toEqual([
        { platform: 'twitter', text: 'x'.repeat(300), isOverLimit: true },
        { platform: 'linkedin', text: 'Short LinkedIn.', isOverLimit: false },
      ]);
      expect(aiTokens.executeWithTokens).toHaveBeenCalledTimes(1);
      expect(aiTokens.executeWithTokens.mock.calls[0][2]).toBe('fit_channels');
      // The platform log column is 30 chars; a joined list would overflow it.
      expect(aiTokens.executeWithTokens.mock.calls[0][3]).toBeUndefined();
      expect(claude.complete).toHaveBeenCalledTimes(2);
    });

    it('fails the whole run (so nothing is charged) when one channel comes back empty', async () => {
      const { svc, claude } = build();
      claude.complete.mockResolvedValue('   ');
      await expect(
        svc.fitChannels(WS, USER, {
          caption: 'Shared caption here',
          channels: [{ platform: 'threads', maxChars: 500 }],
        }),
      ).rejects.toThrow('returned nothing');
    });
  });

  describe('postFromLink', () => {
    it('reads the page, drafts from it, and puts the link on the end', async () => {
      const { svc, claude, aiTokens } = build();
      (fetchPublicHtml as jest.Mock).mockResolvedValue({
        html: '<html>',
        finalUrl: 'https://shop.example/p',
      });
      (extractPageMeta as jest.Mock).mockReturnValue({
        title: ' Lavender candle ',
        description: 'Hand-poured in small batches',
        faviconUrl: '',
      });
      claude.complete.mockResolvedValue('Meet our lavender candle.');
      const out = await svc.postFromLink(WS, USER, {
        url: 'https://shop.example/p',
      });
      expect(out.content).toBe(
        'Meet our lavender candle.\n\nhttps://shop.example/p',
      );
      expect(out.page).toEqual({
        url: 'https://shop.example/p',
        title: 'Lavender candle',
        description: 'Hand-poured in small batches',
      });
      expect(aiTokens.executeWithTokens.mock.calls[0][2]).toBe('link_to_post');
      expect(claude.complete.mock.calls[0][1]).toContain(
        '<title>Lavender candle</title>',
      );
    });

    it('refuses an unreadable page with 422 before metering', async () => {
      const { svc, aiTokens, claude } = build();
      (fetchPublicHtml as jest.Mock).mockResolvedValue(null);
      await expect(
        svc.postFromLink(WS, USER, { url: 'https://nope.example' }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(aiTokens.executeWithTokens).not.toHaveBeenCalled();
      expect(claude.complete).not.toHaveBeenCalled();
    });

    it('treats a fetch that throws (private address, timeout) as unreadable', async () => {
      const { svc, aiTokens } = build();
      (fetchPublicHtml as jest.Mock).mockRejectedValue(
        new Error('Link points at a private address'),
      );
      await expect(
        svc.postFromLink(WS, USER, { url: 'http://10.0.0.1' }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(aiTokens.executeWithTokens).not.toHaveBeenCalled();
    });

    it('refuses a page with neither title nor description before metering', async () => {
      const { svc, aiTokens } = build();
      (fetchPublicHtml as jest.Mock).mockResolvedValue({
        html: '',
        finalUrl: 'https://a.example',
      });
      (extractPageMeta as jest.Mock).mockReturnValue({ faviconUrl: '' });
      await expect(
        svc.postFromLink(WS, USER, { url: 'https://a.example' }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(aiTokens.executeWithTokens).not.toHaveBeenCalled();
    });
  });

  describe('fillBlanks', () => {
    it('fills only from stated facts and reports the blanks it left', async () => {
      const db = dbReturning(
        [{ name: 'Acme Candles', description: null }],
        [{ sells: 'lavender candle', audience: null, voice: [] }],
      );
      const { svc, claude, aiTokens } = build({ db });
      claude.complete.mockResolvedValue(
        '{"brand":"Acme Candles","product_name":"lavender candle","price":"$24"}',
      );
      const out = await svc.fillBlanks(WS, USER, {
        caption: 'New: {{product_name}} for {{price}} from {{brand}}',
        blanks: ['product_name', 'price', 'brand', 'price'],
      });
      expect(out.values).toEqual({
        brand: 'Acme Candles',
        product_name: 'lavender candle',
      });
      expect(out.left).toEqual(['price']);
      expect(aiTokens.executeWithTokens.mock.calls[0][2]).toBe('fill_blanks');
      expect(claude.complete.mock.calls[0][1]).toContain(
        'Brand name: Acme Candles',
      );
    });

    it('still answers (every blank left) when the facts cannot be read', async () => {
      const db = {
        select: jest.fn(() => {
          throw new Error('relation does not exist');
        }),
      };
      const { svc, claude } = build({ db });
      claude.complete.mockResolvedValue('{"brand":"Acme"}');
      const out = await svc.fillBlanks(WS, USER, {
        caption: 'By {{brand}}',
        blanks: ['brand'],
      });
      expect(out.values).toEqual({});
      expect(out.left).toEqual(['brand']);
    });
  });
});
