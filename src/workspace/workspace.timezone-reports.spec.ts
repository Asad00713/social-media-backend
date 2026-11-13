import { Logger } from '@nestjs/common';
import { rescheduleWorkspaceReports } from '../insights/reports/lib/reschedule';
import { WorkspaceService } from './workspace.service';

jest.mock('../insights/reports/lib/reschedule');

/**
 * A time zone change moves the next send of the workspace's scheduled reports.
 * It runs after the row is written, for a rename and a plain save alike, and
 * whatever it does (even rejecting), the settings save succeeds.
 */
const EXISTING = {
  id: 'ws-1',
  name: 'Acme',
  slug: 'acme',
  ownerId: 'user-1',
  timezone: 'UTC',
};

function makeService() {
  const returning = jest.fn();
  const set = jest.fn<
    { where: () => { returning: jest.Mock } },
    [Record<string, unknown>]
  >(() => ({ where: jest.fn(() => ({ returning })) }));
  const findFirst = jest
    .fn()
    // The workspace itself; any later lookup is the slug-taken check.
    .mockResolvedValueOnce(EXISTING)
    .mockResolvedValue(undefined);
  const db = {
    query: { workspace: { findFirst } },
    update: jest.fn(() => ({ set })),
  };
  returning.mockImplementation(() =>
    Promise.resolve([{ ...EXISTING, ...set.mock.calls.at(-1)?.[0] }]),
  );
  const service = new WorkspaceService(
    db as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, db, set };
}

const mockedReschedule = jest.mocked(rescheduleWorkspaceReports);

beforeEach(() => {
  mockedReschedule.mockReset();
  mockedReschedule.mockResolvedValue(1);
});
afterEach(() => jest.restoreAllMocks());

describe('WorkspaceService.update: report time zone', () => {
  it('reschedules the reports when the time zone changes', async () => {
    const { service, db } = makeService();
    const updated = await service.update(
      'ws-1',
      { timezone: 'Asia/Karachi' },
      'user-1',
    );
    expect(updated).toMatchObject({ timezone: 'Asia/Karachi' });
    expect(mockedReschedule).toHaveBeenCalledTimes(1);
    expect(mockedReschedule).toHaveBeenCalledWith(
      db,
      'ws-1',
      'Asia/Karachi',
      expect.any(Date),
    );
  });

  it('reschedules after the row is written', async () => {
    const { service, db } = makeService();
    await service.update('ws-1', { timezone: 'Asia/Karachi' }, 'user-1');
    expect(db.update.mock.invocationCallOrder[0]).toBeLessThan(
      mockedReschedule.mock.invocationCallOrder[0],
    );
  });

  it('reschedules when a rename (new slug) carries the change', async () => {
    const { service, set } = makeService();
    await service.update(
      'ws-1',
      { name: 'Acme Two', timezone: 'Asia/Karachi' },
      'user-1',
    );
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'acme-two', timezone: 'Asia/Karachi' }),
    );
    expect(mockedReschedule).toHaveBeenCalledTimes(1);
  });

  it('does not reschedule for the same time zone', async () => {
    const { service } = makeService();
    await service.update('ws-1', { timezone: 'UTC' }, 'user-1');
    expect(mockedReschedule).not.toHaveBeenCalled();
  });

  it('does not reschedule when the dto has no time zone', async () => {
    const { service } = makeService();
    await service.update('ws-1', { description: 'New' }, 'user-1');
    expect(mockedReschedule).not.toHaveBeenCalled();
  });

  it('still saves the settings when the reschedule fails', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    mockedReschedule.mockRejectedValue(new Error('db down'));
    const { service } = makeService();
    await expect(
      service.update('ws-1', { timezone: 'Asia/Karachi' }, 'user-1'),
    ).resolves.toMatchObject({ timezone: 'Asia/Karachi' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });
});
