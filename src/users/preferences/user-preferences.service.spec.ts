import { NotFoundException } from '@nestjs/common';
import { DEFAULT_PREFERENCES } from './user-preferences';
import { UserPreferencesService } from './user-preferences.service';

/** `db.execute` resolves a pg QueryResult: the rows live on `.rows`. */
function makeService(rows: Array<{ preferences: unknown }>) {
  const execute = jest.fn().mockResolvedValue({ rows });
  return {
    service: new UserPreferencesService({ execute } as never),
    execute,
  };
}

describe('UserPreferencesService', () => {
  it('get() fills defaults over the stored sparse object', async () => {
    const { service } = makeService([{ preferences: { theme: 'dark' } }]);
    expect(await service.get('u1')).toEqual({
      ...DEFAULT_PREFERENCES,
      theme: 'dark',
    });
  });

  it('get() of an unknown user is a 404', async () => {
    const { service } = makeService([]);
    await expect(service.get('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('update() with only unknown keys stores nothing and writes nothing', async () => {
    const { service, execute } = makeService([{ preferences: {} }]);
    const result = await service.update('u1', { bogus: 1 } as never);
    expect(result).toEqual(DEFAULT_PREFERENCES);
    // Only the read ran; no UPDATE was issued.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('update() returns the merged full object from the UPDATE row', async () => {
    const { service, execute } = makeService([
      { preferences: { theme: 'dark', timeFormat: '24h' } },
    ]);
    const result = await service.update('u1', { timeFormat: '24h' });
    expect(result).toEqual({
      ...DEFAULT_PREFERENCES,
      theme: 'dark',
      timeFormat: '24h',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('update() of an unknown user is a 404', async () => {
    const { service } = makeService([]);
    await expect(
      service.update('missing', { theme: 'dark' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
