import { NotFoundException } from '@nestjs/common';
import type { DbType } from '../../drizzle/db';
import { loadWorkspaceTimezone, zonedClock } from './workspace-time';

function fakeDb(rows: Array<{ timezone: string }>): DbType {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
  } as unknown as DbType;
}

describe('zonedClock', () => {
  it('reads 1am twice across the New York fall-back', () => {
    const first = zonedClock(
      new Date('2026-11-01T05:30:00Z'),
      'America/New_York',
    );
    const second = zonedClock(
      new Date('2026-11-01T06:30:00Z'),
      'America/New_York',
    );
    expect(first).toMatchObject({ date: '2026-11-01', hour: 1 });
    expect(second).toMatchObject({ date: '2026-11-01', hour: 1 });
  });

  it('reads midnight as hour 0, never 24', () => {
    expect(
      zonedClock(new Date('2026-06-15T04:00:00Z'), 'America/New_York').hour,
    ).toBe(0);
  });

  it('rolls Kolkata past UTC midnight', () => {
    expect(
      zonedClock(new Date('2026-06-15T18:45:00Z'), 'Asia/Kolkata'),
    ).toEqual({
      date: '2026-06-16',
      weekday: 2,
      hour: 0,
      minute: 15,
    });
  });

  it('puts the Auckland last millisecond on the next day', () => {
    expect(
      zonedClock(new Date('2026-06-15T23:59:59.999Z'), 'Pacific/Auckland').date,
    ).toBe('2026-06-16');
  });

  it('treats an invalid zone as UTC', () => {
    const at = new Date('2026-06-15T18:45:00Z');
    expect(zonedClock(at, 'Mars/Olympus')).toEqual(zonedClock(at, 'UTC'));
  });
});

describe('loadWorkspaceTimezone', () => {
  it('returns the stored zone', async () => {
    await expect(
      loadWorkspaceTimezone(fakeDb([{ timezone: 'Asia/Karachi' }]), 'w1'),
    ).resolves.toBe('Asia/Karachi');
  });

  it('falls back to UTC for an invalid stored zone', async () => {
    await expect(
      loadWorkspaceTimezone(fakeDb([{ timezone: 'Mars/Olympus' }]), 'w1'),
    ).resolves.toBe('UTC');
  });

  it('rejects when the workspace is missing', async () => {
    await expect(
      loadWorkspaceTimezone(fakeDb([]), 'w1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
