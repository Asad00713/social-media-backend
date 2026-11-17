import { RecipientsService } from './recipients.service';

/**
 * `userTimezone` reads one row: the user's saved preference zone and the zone
 * of the workspace they last opened (LEFT-joined: a person with no last
 * workspace still has a preference). The query itself is exercised against
 * Postgres in recipients.service.db.spec.ts; these cases pin which of the two
 * values wins.
 */
function makeService(row: Record<string, unknown> | undefined) {
  const where = jest.fn().mockResolvedValue(row ? [row] : []);
  const leftJoin = jest.fn().mockReturnValue({ where });
  const innerJoin = jest.fn();
  const from = jest.fn().mockReturnValue({ leftJoin, innerJoin });
  const select = jest.fn().mockReturnValue({ from });
  return {
    service: new RecipientsService({ select } as never),
    leftJoin,
    innerJoin,
  };
}

describe('RecipientsService.userTimezone', () => {
  it('prefers the saved preference over the workspace zone', async () => {
    const { service } = makeService({
      preference: 'Europe/Paris',
      timezone: 'Asia/Karachi',
    });
    expect(await service.userTimezone('u1')).toBe('Europe/Paris');
  });

  it('uses the workspace zone when no preference is saved', async () => {
    const { service } = makeService({
      preference: null,
      timezone: 'Asia/Karachi',
    });
    expect(await service.userTimezone('u1')).toBe('Asia/Karachi');
  });

  it('ignores a stored preference that is not an IANA zone', async () => {
    const { service } = makeService({
      preference: 'Mars/Olympus',
      timezone: 'Asia/Karachi',
    });
    expect(await service.userTimezone('u1')).toBe('Asia/Karachi');
  });

  it('uses the preference for a person with no last-opened workspace', async () => {
    const { service } = makeService({
      preference: 'Europe/Paris',
      timezone: null,
    });
    expect(await service.userTimezone('u1')).toBe('Europe/Paris');
  });

  it('falls back to UTC with neither, or with no such user', async () => {
    expect(
      await makeService({
        preference: null,
        timezone: null,
      }).service.userTimezone('u1'),
    ).toBe('UTC');
    expect(await makeService(undefined).service.userTimezone('u1')).toBe('UTC');
  });

  it('LEFT-joins the workspace, never inner-joins it', async () => {
    const { service, leftJoin, innerJoin } = makeService({
      preference: null,
      timezone: null,
    });
    await service.userTimezone('u1');
    expect(leftJoin).toHaveBeenCalledTimes(1);
    expect(innerJoin).not.toHaveBeenCalled();
  });
});
