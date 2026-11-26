import { fetch as undiciFetch } from 'undici';

// The render payload is what Gotenberg's Chromium loads, from inside our
// network: a user-supplied logo URL must never reach it as a URL.
jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { ...actual, fetch: jest.fn() };
});
const mockedFetch = undiciFetch as unknown as jest.Mock;

import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { InsightsChannelsRepository } from '../insights-channels.repository';
import type { GotenbergClient } from './gotenberg.client';
import type { ReportPayloadService } from './report-payload.service';
import type { ReportTokensService } from './report-tokens.service';
import type { ReportPayloadDto } from './reports.dto';
import type { ReportsRepository } from './reports.repository';
import { ReportsService } from './reports.service';

const ID = '00000000-0000-4000-8000-000000000001';
const SHARE = 'a'.repeat(43);
// The type is read from the bytes, so this is a whole PNG signature.
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DATA = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`;

function setup(logoUrl: string | null) {
  const row = { id: ID, workspaceId: 'ws', shareToken: SHARE };
  const record = { row, logoUrl, createdBy: null, updatedBy: null };
  const repo = {
    getById: jest.fn(() => Promise.resolve(record)),
    byShareToken: jest.fn(() => Promise.resolve(record)),
  };
  const payloads = {
    payload: jest.fn(() =>
      Promise.resolve({ name: 'x', logoUrl } as ReportPayloadDto),
    ),
  };
  const tokens = { verifyRender: jest.fn(() => ID) };
  const service = new ReportsService(
    repo as unknown as ReportsRepository,
    {} as InsightsChannelsRepository,
    payloads as unknown as ReportPayloadService,
    { get: jest.fn() } as unknown as ConfigService,
    tokens as unknown as ReportTokensService,
    {} as GotenbergClient,
    {} as Queue,
  );
  return { service };
}

let globalFetch: jest.SpyInstance;
beforeEach(() => {
  mockedFetch.mockReset();
  globalFetch = jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('unguarded global fetch was called'));
});
afterEach(() => jest.restoreAllMocks());

describe('ReportsService.renderPayload (the PDF print page)', () => {
  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8118/logo.png',
    'http://10.0.0.8/logo.png',
    'http://[::1]/logo.png',
  ])('never hands Chromium the private logo %s', async (url) => {
    const out = await setup(url).service.renderPayload('jwt');
    expect(out.logoUrl).toBeNull();
    expect(JSON.stringify(out)).not.toContain(url);
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('inlines a public logo, so Chromium needs no network for it', async () => {
    mockedFetch.mockResolvedValue(
      new Response(PNG, { headers: { 'content-type': 'image/png' } }),
    );
    const url = 'https://93.184.216.34/logo.png';
    const out = await setup(url).service.renderPayload('jwt');
    expect(out.logoUrl).toBe(PNG_DATA);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('leaves the public share link as it was: a visitor browser loads that', async () => {
    const url = 'https://93.184.216.34/logo.png';
    const out = await setup(url).service.publicPayload(SHARE);
    expect(out.logoUrl).toBe(url);
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
