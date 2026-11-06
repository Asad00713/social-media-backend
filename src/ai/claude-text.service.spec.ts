import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// The SDK is mocked: no test here reaches a live model.
const create = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create } })),
}));

import Anthropic from '@anthropic-ai/sdk';
import {
  CLAUDE_FAST_MODEL,
  CLAUDE_VISION_MODEL,
  ClaudeTextService,
} from './claude-text.service';

function service(key: string | null = 'sk-test') {
  return new ClaudeTextService({
    get: jest.fn().mockReturnValue(key ?? undefined),
  } as unknown as ConfigService);
}

function reply(text: string, stop_reason = 'end_turn') {
  return {
    stop_reason,
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text },
    ],
  };
}

describe('ClaudeTextService', () => {
  beforeEach(() => {
    create.mockReset();
    (Anthropic as unknown as jest.Mock).mockClear();
  });

  it('is not ready without ANTHROPIC_API_KEY and refuses to call', async () => {
    const svc = service(null);
    expect(svc.isReady()).toBe(false);
    await expect(svc.complete('s', 'u')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('sends the system prompt and the user text as separate fields, on Haiku at low effort', async () => {
    create.mockResolvedValue(reply('  done  '));
    const out = await service().complete('SYSTEM', 'USER');
    expect(out).toBe('done');
    const body = create.mock.calls[0][0];
    expect(body.model).toBe(CLAUDE_FAST_MODEL);
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.system).toBe('SYSTEM');
    expect(body.messages).toEqual([{ role: 'user', content: 'USER' }]);
    expect(body.output_config).toEqual({ effort: 'low' });
    // The 5.5 models reject non-default sampling values.
    expect(body).not.toHaveProperty('temperature');
  });

  it('describes an image on Sonnet as a base64 image block before the text', async () => {
    create.mockResolvedValue(reply('A red bike.'));
    await service().describeImage('S', 'Describe', {
      mimeType: 'image/png',
      data: 'AAAA',
    });
    const body = create.mock.calls[0][0];
    expect(body.model).toBe(CLAUDE_VISION_MODEL);
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.messages[0].content).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
      },
      { type: 'text', text: 'Describe' },
    ]);
  });

  it('turns a refusal into a 502 rather than returning empty text', async () => {
    create.mockResolvedValue(reply('', 'refusal'));
    await expect(service().complete('s', 'u')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});
