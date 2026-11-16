import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PlatformIncidentsService } from './platform-incidents.service';

const NOW = new Date('2026-11-15T10:00:00Z');

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'inc-1',
    platform: 'instagram',
    severity: 'outage',
    title: 'Instagram is down',
    body: null,
    startedAt: new Date('2026-11-15T09:00:00Z'),
    resolvedAt: null,
    createdBy: 'admin-1',
    updatedBy: 'admin-1',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function build(existing: ReturnType<typeof row> | null = row()) {
  const repo = {
    withStatusLock: jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
      fn('tx'),
    ),
    insertIncident: jest.fn((_tx: unknown, v: Record<string, unknown>) =>
      Promise.resolve(row(v)),
    ),
    findIncident: jest.fn().mockResolvedValue(existing),
    updateIncident: jest.fn(
      (_tx: unknown, _id: string, set: Record<string, unknown>) =>
        Promise.resolve(row(set)),
    ),
    listIncidents: jest.fn().mockResolvedValue([]),
  };
  const status = { applyIncidents: jest.fn().mockResolvedValue([]) };
  const service = new PlatformIncidentsService(repo as never, status as never);
  return { service, repo, status };
}

describe('PlatformIncidentsService', () => {
  it('creates an incident as the admin and re-applies incidents at once', async () => {
    const { service, repo, status } = build();
    const dto = await service.create(
      'admin-1',
      { platform: null, severity: 'delayed', title: 'Meta is slow' },
      NOW,
    );
    expect(repo.insertIncident).toHaveBeenCalledWith(
      'tx',
      expect.objectContaining({
        platform: null,
        severity: 'delayed',
        title: 'Meta is slow',
        body: null,
        startedAt: NOW,
        createdBy: 'admin-1',
      }),
    );
    expect(status.applyIncidents).toHaveBeenCalledWith(NOW);
    expect(dto).toMatchObject({
      platform: null,
      severity: 'delayed',
      resolvedAt: null,
    });
  });

  it('refuses a start time in the future', async () => {
    const { service, repo } = build();
    await expect(
      service.create(
        'admin-1',
        {
          severity: 'outage',
          title: 'x',
          startedAt: new Date(NOW.getTime() + 60 * 60_000),
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.insertIncident).not.toHaveBeenCalled();
  });

  it('updates only the fields sent; platform null moves it to every platform', async () => {
    const { service, repo, status } = build();
    await service.update('admin-2', 'inc-1', { platform: null }, NOW);
    expect(repo.updateIncident).toHaveBeenCalledWith('tx', 'inc-1', {
      platform: null,
      updatedBy: 'admin-2',
      updatedAt: NOW,
    });
    expect(status.applyIncidents).toHaveBeenCalled();
  });

  it('404s an unknown incident', async () => {
    const { service, status } = build(null);
    await expect(
      service.update('a', 'nope', { title: 'x' }, NOW),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.resolve('a', 'nope', NOW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(status.applyIncidents).not.toHaveBeenCalled();
  });

  it('resolves once; a second resolve is a 409', async () => {
    const { service, repo } = build();
    const dto = await service.resolve('admin-1', 'inc-1', NOW);
    expect(dto.resolvedAt).toBe(NOW.toISOString());
    repo.findIncident.mockResolvedValue(row({ resolvedAt: NOW }));
    await expect(
      service.resolve('admin-1', 'inc-1', NOW),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('never resolves before the start (backdated start, skewed clock)', async () => {
    const later = new Date(NOW.getTime() + 60_000);
    const { service, repo } = build(row({ startedAt: later }));
    await service.resolve('admin-1', 'inc-1', NOW);
    expect(repo.updateIncident).toHaveBeenCalledWith(
      'tx',
      'inc-1',
      expect.objectContaining({ resolvedAt: later }),
    );
  });
});
