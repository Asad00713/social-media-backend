import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import type { CloudflareR2Service } from '../media/cloudflare-r2.service';
import { WorkspaceService } from './workspace.service';
import type { WorkspaceTimezoneMoveService } from './workspace-timezone-move.service';

// A time zone change also reschedules the Insights reports (own spec:
// workspace.timezone-reports.spec.ts); not the unit here.
jest.mock('../insights/reports/lib/reschedule');

// The General rules that need no database: what update refuses before it
// writes, and what it never hands to the row. The DB twin of this file
// (workspace.general.db.spec.ts) proves the same against real rows.
const EXISTING = {
  id: 'ws-1',
  name: 'Acme',
  slug: 'acme',
  ownerId: 'owner-1',
  timezone: 'UTC',
};
const OWN_LOGO = 'https://cdn.test/workspace-logos/ws-1/u/1-abc.png';
const MOVED = {
  movedChannels: 2,
  rescheduledPosts: 1,
  queued: false,
  unmovedPosts: 0,
};

function makeService() {
  const returning = jest.fn();
  const set = jest.fn<
    { where: () => { returning: jest.Mock } },
    [Record<string, unknown>]
  >(() => ({ where: jest.fn(() => ({ returning })) }));
  const findFirst = jest
    .fn()
    .mockResolvedValueOnce(EXISTING)
    .mockResolvedValue(undefined);
  const db = {
    query: { workspace: { findFirst } },
    update: jest.fn(() => ({ set })),
  };
  returning.mockImplementation(() =>
    Promise.resolve([{ ...EXISTING, ...set.mock.calls.at(-1)?.[0] }]),
  );
  const r2 = {
    isOwnPublicUrl: jest.fn((url: string) => url === OWN_LOGO),
  };
  // Like the real move: the row is written inside its transaction.
  const timezoneMove = {
    moveExisting: jest.fn(
      async (
        _ws: string,
        _from: string,
        _to: string,
        options?: { writeFirst?: (tx: unknown) => Promise<void> },
      ) => {
        await options?.writeFirst?.(db);
        return MOVED;
      },
    ),
  };
  const service = new WorkspaceService(
    db as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    r2 as unknown as CloudflareR2Service,
    timezoneMove as unknown as WorkspaceTimezoneMoveService,
  );
  return { service, db, set, findFirst, r2, timezoneMove };
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return ((err as BadRequestException).getResponse() as { code?: string })
      .code;
  }
  throw new Error('expected the call to fail');
}

describe('WorkspaceService.update (General)', () => {
  it('takes no caller and checks no owner: the route guard decides', async () => {
    const { service } = makeService();
    await expect(
      service.update('ws-1', { name: 'New' }),
    ).resolves.toMatchObject({ workspace: { name: 'New' } });
  });

  it('answers timezoneMove null and moves nothing without the flag', async () => {
    for (const dto of [{ description: 'x' }, { timezone: 'Asia/Karachi' }]) {
      const { service, timezoneMove } = makeService();
      expect((await service.update('ws-1', dto)).timezoneMove).toBeNull();
      expect(timezoneMove.moveExisting).not.toHaveBeenCalled();
    }
  });

  it('answers timezoneMove null for applyTimezoneToChannels false', async () => {
    const { service, timezoneMove } = makeService();
    const res = await service.update('ws-1', {
      timezone: 'Asia/Karachi',
      applyTimezoneToChannels: false,
    });
    expect(res.timezoneMove).toBeNull();
    expect(timezoneMove.moveExisting).not.toHaveBeenCalled();
  });

  it('moves channels and posts from the old zone to the new one with the flag', async () => {
    const { service, timezoneMove } = makeService();
    const res = await service.update('ws-1', {
      timezone: 'America/New_York',
      applyTimezoneToChannels: true,
    });
    expect(timezoneMove.moveExisting).toHaveBeenCalledWith(
      'ws-1',
      'UTC',
      'America/New_York',
      { writeFirst: expect.any(Function) },
    );
    expect(res.timezoneMove).toEqual(MOVED);
    // The row is written once, by the move's transaction.
    expect(res.workspace).toMatchObject({ timezone: 'America/New_York' });
  });

  it('409 TIMEZONE_MOVE_IN_PROGRESS saves nothing: the row is only written by the move', async () => {
    const { service, db, timezoneMove } = makeService();
    // The locked check refuses before it would run writeFirst.
    timezoneMove.moveExisting.mockRejectedValueOnce(
      new ConflictException({ code: 'TIMEZONE_MOVE_IN_PROGRESS' }),
    );
    await expect(
      service.update('ws-1', {
        timezone: 'America/New_York',
        applyTimezoneToChannels: true,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('400 TIMEZONE_REQUIRED when applyTimezoneToChannels comes without a timezone, before any write', async () => {
    const { service, db } = makeService();
    expect(
      await codeOf(service.update('ws-1', { applyTimezoneToChannels: true })),
    ).toBe('TIMEZONE_REQUIRED');
    expect(
      await codeOf(service.update('ws-1', { applyTimezoneToChannels: false })),
    ).toBe('TIMEZONE_REQUIRED');
    expect(db.update).not.toHaveBeenCalled();
  });

  it('never writes applyTimezoneToChannels into the row', async () => {
    const { service, set } = makeService();
    await service.update('ws-1', {
      timezone: 'UTC',
      applyTimezoneToChannels: true,
    });
    expect(set.mock.calls[0][0]).not.toHaveProperty('applyTimezoneToChannels');
    expect(set.mock.calls[0][0]).toMatchObject({ timezone: 'UTC' });
  });

  it('400 LOGO_NOT_UPLOADED for a URL our presign did not issue, before any write', async () => {
    const { service, db, r2 } = makeService();
    expect(
      await codeOf(service.update('ws-1', { logo: 'https://evil.test/p.png' })),
    ).toBe('LOGO_NOT_UPLOADED');
    expect(r2.isOwnPublicUrl).toHaveBeenCalledWith(
      'https://evil.test/p.png',
      'workspace-logo',
      'ws-1',
    );
    expect(db.update).not.toHaveBeenCalled();
  });

  it('saves a logo our presign issued', async () => {
    const { service, set } = makeService();
    await service.update('ws-1', { logo: OWN_LOGO });
    expect(set.mock.calls[0][0]).toMatchObject({ logo: OWN_LOGO });
  });

  it('null clears the logo without asking R2', async () => {
    const { service, set, r2 } = makeService();
    await service.update('ws-1', { logo: null });
    expect(set.mock.calls[0][0]).toMatchObject({ logo: null });
    expect(r2.isOwnPublicUrl).not.toHaveBeenCalled();
  });

  it('writes the publishing defaults', async () => {
    const { service, set } = makeService();
    await service.update('ws-1', {
      approvalPolicy: 'members',
      shortenLinksDefault: true,
      utmDefault: true,
    });
    expect(set.mock.calls[0][0]).toMatchObject({
      approvalPolicy: 'members',
      shortenLinksDefault: true,
      utmDefault: true,
    });
  });
});

describe('WorkspaceService.findDetail', () => {
  function withRow(row: unknown) {
    const { service, findFirst } = makeService();
    findFirst.mockReset();
    findFirst.mockResolvedValue(row);
    return { service, findFirst };
  }
  const base = {
    ...EXISTING,
    isActive: true,
    suspendedReason: null,
  };

  it('asks the database to leave out both secrets', async () => {
    const { service, findFirst } = withRow({
      ...base,
      owner: { id: 'o', name: 'Olive', email: 'o@example.test' },
    });
    await service.findDetail('ws-1');
    expect(findFirst.mock.calls[0][0]).toMatchObject({
      columns: { maestroAnthropicKey: false, inviteLinkCode: false },
    });
  });

  it('ownerName is the name, or the email when there is none', async () => {
    const named = withRow({
      ...base,
      owner: { id: 'o', name: 'Olive', email: 'o@example.test' },
    });
    await expect(named.service.findDetail('ws-1')).resolves.toMatchObject({
      ownerName: 'Olive',
    });
    const unnamed = withRow({
      ...base,
      owner: { id: 'o', name: null, email: 'o@example.test' },
    });
    await expect(unnamed.service.findDetail('ws-1')).resolves.toMatchObject({
      ownerName: 'o@example.test',
    });
  });

  it('404 for a workspace that does not exist', async () => {
    const { service } = withRow(undefined);
    await expect(service.findDetail('nope')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('403 for a suspended workspace', async () => {
    const { service } = withRow({
      ...base,
      isActive: false,
      suspendedReason: 'non_payment',
      owner: { id: 'o', name: 'Olive', email: 'o@example.test' },
    });
    await expect(service.findDetail('ws-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
