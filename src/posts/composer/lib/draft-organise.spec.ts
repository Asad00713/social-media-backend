/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- test doubles are loosely typed */
import { BadRequestException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  MAX_LABELS,
  campaignToCheck,
  normaliseLabels,
  organiseMeta,
  readOrganise,
  resolveOrganise,
} from './draft-organise';

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';

describe('normaliseLabels', () => {
  it('trims, collapses spaces, drops empties and non-strings', () => {
    expect(
      normaliseLabels(['  Launch ', 'Hot   drinks', '', '   ', 3]),
    ).toEqual(['Launch', 'Hot drinks']);
  });

  it('dedupes case-insensitively, keeping the first spelling', () => {
    expect(normaliseLabels(['Launch', 'launch', 'LAUNCH', 'Drinks'])).toEqual([
      'Launch',
      'Drinks',
    ]);
  });

  it(`keeps at most ${MAX_LABELS}`, () => {
    const many = Array.from({ length: MAX_LABELS + 5 }, (_, i) => `l${i}`);
    expect(normaliseLabels(many)).toHaveLength(MAX_LABELS);
    expect(normaliseLabels(many, 3)).toEqual(['l0', 'l1', 'l2']);
  });
});

describe('organiseMeta — absent keeps, present sets', () => {
  const stored = { campaignId: C1, labels: ['Launch'], title: 'x' };

  it('keeps the stored campaign and labels when the keys are absent', () => {
    expect(organiseMeta(stored, {})).toEqual({
      campaignId: C1,
      labels: ['Launch'],
    });
  });

  it('null clears the campaign; an empty list clears the labels', () => {
    expect(organiseMeta(stored, { campaignId: null, labels: [] })).toEqual({});
  });

  it('a string sets the campaign and a list replaces the labels', () => {
    expect(
      organiseMeta(stored, { campaignId: C2, labels: ['Drinks', 'drinks'] }),
    ).toEqual({ campaignId: C2, labels: ['Drinks'] });
  });

  it('carries the slot of a materialised post while its campaign stays', () => {
    const slot = { date: '2026-11-10', channelId: '7' };
    const materialised = { campaignId: C1, campaignSlot: slot };
    expect(organiseMeta(materialised, {}).campaignSlot).toEqual(slot);
    expect(organiseMeta(materialised, { campaignId: C1 }).campaignSlot).toEqual(
      slot,
    );
  });

  it('drops the slot when the post moves to another campaign or none', () => {
    const materialised = { campaignId: C1, campaignSlot: { date: 'd' } };
    expect(organiseMeta(materialised, { campaignId: C2 })).toEqual({
      campaignId: C2,
    });
    expect(organiseMeta(materialised, { campaignId: null })).toEqual({});
  });

  it('writes nothing for a post that never had either', () => {
    expect(organiseMeta(undefined, {})).toEqual({});
    expect(organiseMeta(null, { labels: null })).toEqual({});
  });
});

describe('readOrganise', () => {
  it('reads the stored filing, defaulting to none', () => {
    expect(readOrganise({ campaignId: C1, labels: ['A'] })).toEqual({
      campaignId: C1,
      labels: ['A'],
    });
    expect(readOrganise({ campaignId: 7, labels: 'A' })).toEqual({
      campaignId: null,
      labels: [],
    });
    expect(readOrganise(null)).toEqual({ campaignId: null, labels: [] });
  });
});

describe('campaignToCheck', () => {
  it('checks only a NEW campaign id', () => {
    expect(campaignToCheck({ campaignId: C1 }, { campaignId: C1 })).toBeNull();
    expect(campaignToCheck({ campaignId: C1 }, { campaignId: C2 })).toBe(C2);
    expect(campaignToCheck({}, { campaignId: C1 })).toBe(C1);
    expect(
      campaignToCheck({ campaignId: C1 }, { campaignId: null }),
    ).toBeNull();
    expect(campaignToCheck({ campaignId: C1 }, {})).toBeNull();
  });
});

describe('resolveOrganise', () => {
  function db(found: boolean) {
    const where = jest.fn(() => ({
      limit: () => Promise.resolve(found ? [{ id: C2 }] : []),
    }));
    return {
      where,
      db: { select: () => ({ from: () => ({ where }) }) } as any,
    };
  }

  it('refuses a campaign outside the workspace', async () => {
    const { db: d } = db(false);
    await expect(
      resolveOrganise(d, 'w1', {}, { campaignId: C2 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a campaign inside the workspace', async () => {
    const { db: d, where } = db(true);
    await expect(
      resolveOrganise(d, 'w1', {}, { campaignId: C2 }),
    ).resolves.toEqual({ campaignId: C2 });
    expect(where).toHaveBeenCalledTimes(1);
    // Scoped to THIS workspace: the id alone would accept another tenant's.
    const q = new PgDialect().sqlToQuery(
      (where.mock.calls[0] as unknown as [SQL])[0],
    );
    expect(q.sql).toContain('"campaigns"."workspace_id" = $2');
    expect(q.params).toEqual([C2, 'w1']);
  });

  it('does not query for an unchanged link', async () => {
    const { db: d, where } = db(false);
    await resolveOrganise(d, 'w1', { campaignId: C1 }, { campaignId: C1 });
    expect(where).not.toHaveBeenCalled();
  });
});
