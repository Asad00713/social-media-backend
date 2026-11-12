import { csvCell } from '../lib/content-table';
import type { AudienceGrowthDto } from './audience.dto';

/**
 * `gained_since_start` is the change since the window's first reading, so it
 * is cumulative, not a daily gain.
 */
export const AUDIENCE_CSV_HEADER = [
  'date',
  'channel',
  'platform',
  'followers',
  'gained_since_start',
];

/**
 * The growth table as a CSV: one row per channel per day, channels in the
 * order the response lists them. A day with no reading is an empty cell. The
 * BOM is what makes Excel read non-Latin channel names as UTF-8, as in the
 * posts export.
 */
export function audienceCsv(growth: AudienceGrowthDto): string {
  const lines = [AUDIENCE_CSV_HEADER.join(',')];
  for (const channel of growth.channels) {
    for (const point of channel.series) {
      lines.push(
        [
          point.date,
          channel.name,
          channel.platform,
          point.followers,
          point.gained,
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
