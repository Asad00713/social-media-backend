import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CHANNEL_CATEGORY,
  SupportedPlatform,
} from '../../drizzle/schema/channels.schema';
import { GENERAL_TIMES, generalWindowsFor } from './general-times';

const platforms = Object.keys(GENERAL_TIMES) as SupportedPlatform[];

describe('GENERAL_TIMES', () => {
  it('only contains social platforms', () => {
    expect(platforms.length).toBeGreaterThan(0);
    for (const p of platforms) expect(CHANNEL_CATEGORY[p]).toBe('social');
  });

  it('has valid weekday and hour on every window', () => {
    for (const p of platforms) {
      for (const w of GENERAL_TIMES[p]!) {
        expect(Number.isInteger(w.weekday)).toBe(true);
        expect(w.weekday).toBeGreaterThanOrEqual(0);
        expect(w.weekday).toBeLessThanOrEqual(6);
        expect(Number.isInteger(w.hour)).toBe(true);
        expect(w.hour).toBeGreaterThanOrEqual(0);
        expect(w.hour).toBeLessThanOrEqual(23);
      }
    }
  });

  it('has no duplicate (weekday, hour) within a platform', () => {
    for (const p of platforms) {
      const keys = GENERAL_TIMES[p]!.map((w) => `${w.weekday}-${w.hour}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('has 3 to 6 windows per present platform', () => {
    for (const p of platforms) {
      expect(GENERAL_TIMES[p]!.length).toBeGreaterThanOrEqual(3);
      expect(GENERAL_TIMES[p]!.length).toBeLessThanOrEqual(6);
    }
  });

  it('returns [] for unsourced platforms', () => {
    expect(generalWindowsFor('reddit')).toEqual([]);
    expect(generalWindowsFor('bluesky')).toEqual([]);
  });

  it('returns the table entry for sourced platforms', () => {
    expect(generalWindowsFor('linkedin')).toBe(GENERAL_TIMES.linkedin);
  });

  it('precedes every platform block with a source URL comment', () => {
    const text = readFileSync(join(__dirname, 'general-times.ts'), 'utf8');
    for (const p of platforms) {
      const idx = text.indexOf(`\n  ${p}: [`);
      expect(idx).toBeGreaterThan(-1);
      const before = text.slice(0, idx).split('\n').slice(-6).join('\n');
      expect(before).toMatch(/https:\/\//);
    }
  });
});
