import { fetch as undiciFetch } from 'undici';

// A DM with several attachments uploads them one by one. When attachment
// N > 1 is refused by the SSRF guard, the first N-1 are already in the
// conversation: the 400 must say so, as the non-2xx path's message does.
jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { ...actual, fetch: jest.fn() };
});
const mockedFetch = undiciFetch as unknown as jest.Mock;

import { BadRequestException } from '@nestjs/common';
import type { SlackService } from '../../channels/services/slack.service';
import type { TelegramService } from '../../channels/services/telegram.service';
import type { ResolvedChannel } from './inbox-adapter.interface';
import { SlackDmAdapter } from './slack-dm.adapter';
import { TelegramDmAdapter } from './telegram-dm.adapter';

const PUBLIC_URL = 'https://93.184.216.34/a.png';
const PRIVATE_URL = 'http://169.254.169.254/latest/meta-data/';
const BIG_URL = 'https://93.184.216.35/big.png';
const UNREACHABLE = "That attachment link isn't reachable from the internet.";
const TOO_LARGE = 'That attachment is too large.';
const channel = { accessToken: 'tok' } as unknown as ResolvedChannel;
const att = (url: string) => ({
  kind: 'image' as const,
  url,
  contentType: 'image/png',
});

async function message400(p: Promise<unknown>): Promise<string> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BadRequestException);
  expect((err as BadRequestException).getStatus()).toBe(400);
  return (err as BadRequestException).message;
}

let globalFetch: jest.SpyInstance;
beforeEach(() => {
  mockedFetch.mockReset();
  mockedFetch.mockImplementation((url: string) =>
    Promise.resolve(
      url === BIG_URL
        ? new Response('x', {
            headers: { 'content-length': String(5 * 1024 * 1024 * 1024) },
          })
        : new Response('png'),
    ),
  );
  globalFetch = jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('unguarded global fetch was called'));
});
afterEach(() => jest.restoreAllMocks());

describe.each([
  [
    'Slack',
    () => {
      const uploadFile = jest.fn(() => Promise.resolve({ fileId: 'F1' }));
      const adapter = new SlackDmAdapter({
        uploadFile,
      } as unknown as SlackService);
      return { adapter, sent: uploadFile, to: 'C1' };
    },
  ],
  [
    'Telegram',
    () => {
      const sendPhoto = jest.fn(() =>
        Promise.resolve({ message_id: 7, date: 1_700_000_000 }),
      );
      const adapter = new TelegramDmAdapter({
        forToken: () => ({ sendPhoto }),
      } as unknown as TelegramService);
      return { adapter, sent: sendPhoto, to: '42' };
    },
  ],
])('%s DM: a refusal after some uploads', (_name, make) => {
  it('keeps the count when attachment 2 of 3 is refused', async () => {
    const { adapter, sent, to } = make();
    const msg = await message400(
      adapter.sendDmWithAttachments(channel, to, 'hi', [
        att(PUBLIC_URL),
        att(PRIVATE_URL),
        att(PUBLIC_URL),
      ]),
    );
    expect(msg).toBe(
      `Failed to fetch attachment 2/3 after 1 uploaded: ${UNREACHABLE}`,
    );
    expect(sent).toHaveBeenCalledTimes(1);
    // Only the public one was requested; the private one never was.
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('keeps the count for a body over the cap', async () => {
    const { adapter, sent, to } = make();
    const msg = await message400(
      adapter.sendDmWithAttachments(channel, to, 'hi', [
        att(PUBLIC_URL),
        att(PUBLIC_URL),
        att(BIG_URL),
      ]),
    );
    expect(msg).toBe(
      `Failed to fetch attachment 3/3 after 2 uploaded: ${TOO_LARGE}`,
    );
    expect(sent).toHaveBeenCalledTimes(2);
  });

  it('a refusal of the first attachment is still the plain copy', async () => {
    const { adapter, sent, to } = make();
    const msg = await message400(
      adapter.sendDmWithAttachments(channel, to, 'hi', [
        att(PRIVATE_URL),
        att(PUBLIC_URL),
      ]),
    );
    expect(msg).toBe(UNREACHABLE);
    expect(sent).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('a real network error after an upload still passes through as it is', async () => {
    const { adapter, to } = make();
    const boom = new TypeError('fetch failed');
    mockedFetch
      .mockResolvedValueOnce(new Response('png'))
      .mockRejectedValueOnce(boom);
    await expect(
      adapter.sendDmWithAttachments(channel, to, 'hi', [
        att(PUBLIC_URL),
        att(PUBLIC_URL),
      ]),
    ).rejects.toBe(boom);
  });
});
