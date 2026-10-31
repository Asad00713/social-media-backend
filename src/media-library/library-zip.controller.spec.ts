import 'reflect-metadata';
import {
  HttpStatus,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { LibraryZipController } from './library-zip.controller';
import { MediaLibraryController } from './media-library.controller';
import { signZipTicket, verifyZipTicket } from './lib/zip-ticket';

const SECRET = 'k'.repeat(64);
const NOW = new Date('2026-01-15T12:00:00.000Z');
const WS = '11111111-1111-4111-8111-111111111111';
const FOLDER = '22222222-2222-4222-8222-222222222222';
const OTHER_FOLDER = '44444444-4444-4444-8444-444444444444';
const USER = '33333333-3333-4333-8333-333333333333';

const ENV_KEYS = ['LIBRARY_ZIP_TICKET_SECRET', 'API_PUBLIC_URL'] as const;
const savedEnv: Record<string, string | undefined> = {};
let errorLog: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  errorLog = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.LIBRARY_ZIP_TICKET_SECRET = SECRET;
  process.env.API_PUBLIC_URL = 'https://api.example.test';
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function ticketFor(
  over: Partial<{
    workspaceId: string;
    categoryId: string;
    userId: string;
  }> = {},
  signedAt: Date = NOW,
): string {
  return signZipTicket(
    { workspaceId: WS, categoryId: FOLDER, userId: USER, ...over },
    SECRET,
    signedAt,
  ).ticket;
}

function makeDownload(access: { assertCan: jest.Mock }) {
  const categoryZip = { streamZip: jest.fn().mockResolvedValue(undefined) };
  const ctrl = Object.assign(
    Object.create(LibraryZipController.prototype) as object,
    { categoryZip, access },
  ) as unknown as LibraryZipController;
  return {
    categoryZip,
    downloadCategoryZip: (
      ...args: Parameters<LibraryZipController['downloadCategoryZip']>
    ) => ctrl.downloadCategoryZip(...args),
  };
}

const okAccess = () => ({ assertCan: jest.fn().mockResolvedValue('MEMBER') });
const res = {} as Response;

async function expectInvalidTicket(p: Promise<unknown>) {
  const err: unknown = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UnauthorizedException);
  const http = err as UnauthorizedException;
  expect(http.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
  expect(http.getResponse()).toEqual({
    code: 'INVALID_TICKET',
    message: 'This download link is invalid or has expired.',
  });
}

describe('LibraryZipController.downloadCategoryZip', () => {
  it('401s without a ticket and never streams', async () => {
    const c = makeDownload(okAccess());
    await expectInvalidTicket(
      c.downloadCategoryZip(WS, FOLDER, undefined, res),
    );
    expect(c.categoryZip.streamZip).not.toHaveBeenCalled();
  });

  it('401s on an expired ticket', async () => {
    const c = makeDownload(okAccess());
    const stale = ticketFor({}, new Date(NOW.getTime() - 5 * 60 * 1000 - 1));
    await expectInvalidTicket(c.downloadCategoryZip(WS, FOLDER, stale, res));
    expect(c.categoryZip.streamZip).not.toHaveBeenCalled();
  });

  it('401s on a ticket minted for another folder', async () => {
    const c = makeDownload(okAccess());
    const other = ticketFor({ categoryId: OTHER_FOLDER });
    await expectInvalidTicket(c.downloadCategoryZip(WS, FOLDER, other, res));
    expect(c.categoryZip.streamZip).not.toHaveBeenCalled();
  });

  it('401s on a ticket minted for another workspace', async () => {
    const c = makeDownload(okAccess());
    const other = ticketFor({ workspaceId: OTHER_FOLDER });
    await expectInvalidTicket(c.downloadCategoryZip(WS, FOLDER, other, res));
    expect(c.categoryZip.streamZip).not.toHaveBeenCalled();
  });

  it("401s when the ticket's user has since lost access", async () => {
    const access = {
      assertCan: jest.fn().mockRejectedValue(new NotFoundException()),
    };
    const c = makeDownload(access);
    await expectInvalidTicket(
      c.downloadCategoryZip(WS, FOLDER, ticketFor(), res),
    );
    expect(access.assertCan).toHaveBeenCalledWith(WS, USER, 'posts:draft');
    expect(c.categoryZip.streamZip).not.toHaveBeenCalled();
  });

  it('401s when the secret is not configured', async () => {
    const c = makeDownload(okAccess());
    const t = ticketFor();
    delete process.env.LIBRARY_ZIP_TICKET_SECRET;
    await expectInvalidTicket(c.downloadCategoryZip(WS, FOLDER, t, res));
    expect(c.categoryZip.streamZip).not.toHaveBeenCalled();
  });

  it('streams the folder for a valid ticket', async () => {
    const access = okAccess();
    const c = makeDownload(access);
    await c.downloadCategoryZip(WS, FOLDER, ticketFor(), res);
    expect(access.assertCan).toHaveBeenCalledWith(WS, USER, 'posts:draft');
    expect(c.categoryZip.streamZip).toHaveBeenCalledWith(WS, FOLDER, res);
  });
});

describe('MediaLibraryController.createCategoryZipTicket', () => {
  function makeTicketRoute() {
    const categoryZip = {
      assertZippable: jest.fn().mockResolvedValue(undefined),
    };
    const ctrl = Object.assign(
      Object.create(MediaLibraryController.prototype) as object,
      { categoryZip },
    ) as unknown as MediaLibraryController;
    return {
      categoryZip,
      createCategoryZipTicket: (
        ...args: Parameters<MediaLibraryController['createCategoryZipTicket']>
      ) => ctrl.createCategoryZipTicket(...args),
    };
  }
  const user = { userId: USER };

  it('503s when LIBRARY_ZIP_TICKET_SECRET is unset, and logs why', async () => {
    delete process.env.LIBRARY_ZIP_TICKET_SECRET;
    const c = makeTicketRoute();
    await expect(
      c.createCategoryZipTicket(WS, FOLDER, user),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('LIBRARY_ZIP_TICKET_SECRET'),
    );
  });

  it('503s when the secret is too short to be a real key', async () => {
    process.env.LIBRARY_ZIP_TICKET_SECRET = 'short';
    const c = makeTicketRoute();
    await expect(
      c.createCategoryZipTicket(WS, FOLDER, user),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('503s when API_PUBLIC_URL is unset', async () => {
    delete process.env.API_PUBLIC_URL;
    const c = makeTicketRoute();
    await expect(
      c.createCategoryZipTicket(WS, FOLDER, user),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('propagates the folder checks before minting', async () => {
    const c = makeTicketRoute();
    c.categoryZip.assertZippable.mockRejectedValue(new NotFoundException());
    await expect(
      c.createCategoryZipTicket(WS, FOLDER, user),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns an absolute download URL carrying a ticket for this user and folder', async () => {
    const c = makeTicketRoute();
    const out = await c.createCategoryZipTicket(WS, FOLDER, user);
    expect(c.categoryZip.assertZippable).toHaveBeenCalledWith(WS, FOLDER);
    expect(out.url).toContain(`/categories/${FOLDER}/zip?ticket=`);
    expect(
      out.url.startsWith(
        `https://api.example.test/workspaces/${WS}/media-library/categories/${FOLDER}/zip?ticket=`,
      ),
    ).toBe(true);
    expect(out.expiresAt).toBe(
      new Date(NOW.getTime() + 5 * 60 * 1000).toISOString(),
    );
    const ticket = new URL(out.url).searchParams.get('ticket') ?? '';
    expect(verifyZipTicket(ticket, SECRET, NOW)).toEqual(
      expect.objectContaining({
        workspaceId: WS,
        categoryId: FOLDER,
        userId: USER,
      }),
    );
  });

  it('drops a trailing slash from API_PUBLIC_URL', async () => {
    process.env.API_PUBLIC_URL = 'https://api.example.test/';
    const c = makeTicketRoute();
    const out = await c.createCategoryZipTicket(WS, FOLDER, user);
    expect(out.url).toContain(`https://api.example.test/workspaces/${WS}/`);
  });
});
