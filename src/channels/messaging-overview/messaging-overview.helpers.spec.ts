import {
  rangeToDays,
  buildActivitySeries,
  mapTopChannels,
  buildChannelMix,
  type ChannelInfo,
} from './messaging-overview.helpers';

describe('rangeToDays', () => {
  it('maps ranges to day counts', () => {
    expect(rangeToDays('7d')).toBe(7);
    expect(rangeToDays('30d')).toBe(30);
    expect(rangeToDays('90d')).toBe(90);
  });
});

describe('buildActivitySeries', () => {
  it('0-fills missing days, oldest to newest', () => {
    const today = new Date('2026-07-03T12:00:00Z');
    const rows = [
      { date: '2026-07-03', count: 5 },
      { date: '2026-07-01', count: 2 },
    ];
    const series = buildActivitySeries(rows, 3, today);
    expect(series).toHaveLength(3);
    expect(series.map((p) => p.messages)).toEqual([2, 0, 5]);
  });
});

describe('mapTopChannels', () => {
  it('resolves names, falls back for DMs and unknown ids', () => {
    const map = new Map<string, ChannelInfo>([
      ['C1', { name: 'general', isPrivate: false }],
    ]);
    const rows = [
      { conversationId: 'C1', count: 10 },
      { conversationId: 'D9', count: 4 },
      { conversationId: 'CZ', count: 1 },
    ];
    const out = mapTopChannels(rows, map);
    expect(out[0]).toEqual({ id: 'C1', name: 'general', isPrivate: false, messages: 10 });
    expect(out[1]).toEqual({ id: 'D9', name: 'Direct message', isPrivate: true, messages: 4 });
    expect(out[2]).toEqual({ id: 'CZ', name: 'CZ', isPrivate: false, messages: 1 });
  });
});

describe('buildChannelMix', () => {
  it('builds Public/Private/DMs slices', () => {
    expect(buildChannelMix(13, 5, 24)).toEqual([
      { label: 'Public', value: 13 },
      { label: 'Private', value: 5 },
      { label: 'DMs', value: 24 },
    ]);
  });
});
