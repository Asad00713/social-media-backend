import { Logger } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';
import { LibrarySamplesService } from '../media-library/samples/library-samples.service';

/**
 * Workspace creation seeds Library samples off the request path. Whatever the
 * seeder does (throws, rejects, hangs), creating the workspace must succeed,
 * unchanged and without waiting for it.
 */
const WS = { id: 'ws-new', name: 'Acme', slug: 'acme', ownerId: 'user-1' };

function makeService(samples: Pick<LibrarySamplesService, 'seedInBackground'>) {
  const returning = jest.fn().mockResolvedValue([WS]);
  const db = {
    query: { workspace: { findFirst: jest.fn().mockResolvedValue(undefined) } },
    insert: jest.fn(() => ({ values: jest.fn(() => ({ returning })) })),
  };
  const service = new WorkspaceService(
    db as never,
    { enforceWorkspaceLimit: jest.fn().mockResolvedValue(undefined) } as never,
    {
      findOne: jest
        .fn()
        .mockResolvedValue({ lastAccessedWorkspaceId: 'ws-old' }),
      setLastAccessedWorkspace: jest.fn(),
    } as never,
    { createSubscription: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    {} as never,
    {} as never,
    samples as LibrarySamplesService,
  );
  // Covered by workspace.usage-seed.spec.ts; not the unit here.
  jest
    .spyOn(
      service as unknown as { seedWorkspaceUsage: () => Promise<void> },
      'seedWorkspaceUsage',
    )
    .mockResolvedValue(undefined);
  return { service, db, returning };
}

afterEach(() => jest.restoreAllMocks());

describe('WorkspaceService.create: Library samples', () => {
  it('schedules the samples for the new workspace, after its row exists', async () => {
    const samples = { seedInBackground: jest.fn() };
    const { service, returning } = makeService(samples);

    await expect(
      service.create({ name: 'Acme' } as never, 'user-1'),
    ).resolves.toBe(WS);

    expect(samples.seedInBackground).toHaveBeenCalledTimes(1);
    expect(samples.seedInBackground).toHaveBeenCalledWith('ws-new');
    expect(returning.mock.invocationCallOrder[0]).toBeLessThan(
      samples.seedInBackground.mock.invocationCallOrder[0],
    );
  });

  it('still creates the workspace when scheduling throws', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const samples = {
      seedInBackground: jest.fn(() => {
        throw new Error('boom');
      }),
    };
    const { service } = makeService(samples);

    await expect(
      service.create({ name: 'Acme' } as never, 'user-1'),
    ).resolves.toBe(WS);
  });

  it('does not wait for a seed that never finishes', async () => {
    const real = new LibrarySamplesService({} as never);
    jest.spyOn(real, 'seed').mockReturnValue(new Promise(() => undefined));
    const { service } = makeService(real);

    await expect(
      service.create({ name: 'Acme' } as never, 'user-1'),
    ).resolves.toBe(WS);
  });
});

describe('LibrarySamplesService.seedInBackground', () => {
  it('starts after the current request work, and a failure is only logged', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const svc = new LibrarySamplesService({} as never);
    const seed = jest
      .spyOn(svc, 'seed')
      .mockRejectedValue(new Error('db down'));
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    try {
      expect(svc.seedInBackground('ws-1')).toBeUndefined();
      // Not started yet: the response goes out first.
      expect(seed).not.toHaveBeenCalled();

      await new Promise((r) => setImmediate(r));
      expect(seed).toHaveBeenCalledWith('ws-1');
      await new Promise((r) => setImmediate(r));

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('Library samples failed for workspace ws-1'),
      );
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
