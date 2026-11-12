import type { AudienceGrowthDto } from './audience.dto';
import { audienceCsv } from './audience-csv';

const BOM = '\uFEFF';

function growth(channels: AudienceGrowthDto['channels']): AudienceGrowthDto {
  return {
    window: { from: '2026-10-01', to: '2026-10-02' },
    total: { current: null, change: null, series: [] },
    channels,
  };
}

describe('audienceCsv', () => {
  it('starts with the exact header line', () => {
    const body = audienceCsv(growth([]));
    expect(body).toBe(
      `${BOM}date,channel,platform,followers,gained_since_start\r\n`,
    );
  });

  it('writes one row per channel per day, in the response order', () => {
    const body = audienceCsv(
      growth([
        {
          channelId: 2,
          platform: 'instagram',
          name: 'acme',
          current: 12,
          change: 2,
          series: [
            { date: '2026-10-01', followers: 10, gained: 0 },
            { date: '2026-10-02', followers: 12, gained: 2 },
          ],
        },
        {
          channelId: 1,
          platform: 'twitter',
          name: 'acme_tw',
          current: 5,
          change: -1,
          series: [
            { date: '2026-10-01', followers: 6, gained: 0 },
            { date: '2026-10-02', followers: 5, gained: -1 },
          ],
        },
      ]),
    );
    expect(body.replace(BOM, '').split('\r\n')).toEqual([
      'date,channel,platform,followers,gained_since_start',
      '2026-10-01,acme,instagram,10,0',
      '2026-10-02,acme,instagram,12,2',
      '2026-10-01,acme_tw,twitter,6,0',
      '2026-10-02,acme_tw,twitter,5,-1',
      '',
    ]);
  });

  it('renders a null as an empty cell', () => {
    const body = audienceCsv(
      growth([
        {
          channelId: 1,
          platform: 'bluesky',
          name: 'new',
          current: null,
          change: null,
          series: [{ date: '2026-10-01', followers: null, gained: null }],
        },
      ]),
    );
    expect(body.split('\r\n')[1]).toBe('2026-10-01,new,bluesky,,');
  });

  it('quotes a channel name with a comma', () => {
    const body = audienceCsv(
      growth([
        {
          channelId: 1,
          platform: 'mastodon',
          name: 'Acme, Inc',
          current: 1,
          change: 0,
          series: [{ date: '2026-10-01', followers: 1, gained: 0 }],
        },
      ]),
    );
    expect(body.split('\r\n')[1]).toBe('2026-10-01,"Acme, Inc",mastodon,1,0');
  });
});
