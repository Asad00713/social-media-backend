import type { InsightPost } from './insight-post';
import { csvCell, filterAndSort, postsCsv, tableTotals } from './content-table';

const ip = (over: Partial<InsightPost>): InsightPost => ({
  postId: 'p',
  channelId: 1,
  publishedAt: '2026-09-21T10:00:00.000Z',
  content: '',
  format: 'image',
  thumbnailUrl: null,
  permalink: null,
  likes: null,
  comments: null,
  shares: null,
  impressions: null,
  engagements: 0,
  engagementRate: null,
  ...over,
});

describe('filterAndSort', () => {
  const rows = [
    ip({
      postId: 'a',
      engagementRate: 2,
      publishedAt: '2026-09-21T00:00:00.000Z',
    }),
    ip({
      postId: 'zero-impr',
      engagementRate: null,
      publishedAt: '2026-09-25T00:00:00.000Z',
    }),
    ip({
      postId: 'b',
      engagementRate: 9,
      format: 'video',
      publishedAt: '2026-09-22T00:00:00.000Z',
    }),
  ];

  it('puts unmeasured posts last whichever way it sorts', () => {
    const order = (o: 'asc' | 'desc') =>
      filterAndSort(rows, {
        format: 'all',
        sort: 'engagementRate',
        order: o,
      }).map((r) => r.postId);
    expect(order('desc')).toEqual(['b', 'a', 'zero-impr']);
    expect(order('asc')).toEqual(['a', 'b', 'zero-impr']);
  });

  it('filters by format and sorts by date', () => {
    expect(
      filterAndSort(rows, {
        format: 'image',
        sort: 'publishedAt',
        order: 'desc',
      }).map((r) => r.postId),
    ).toEqual(['zero-impr', 'a']);
  });
});

describe('tableTotals', () => {
  it('sums the rows and rates only rated posts', () => {
    expect(
      tableTotals([
        ip({ likes: 10, comments: 2, engagements: 12, impressions: 600 }),
        ip({ likes: 40, engagements: 40 }), // no impressions
      ]),
    ).toEqual({
      posts: 2,
      impressions: 600,
      engagements: 52,
      engagementRate: 2,
      likes: 50,
      comments: 2,
      shares: null,
    });
  });
});

describe('csvCell', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });
  it('defuses a cell a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@me')).toBe("'@me");
  });
  it('writes numbers plainly, negatives included, and null as empty', () => {
    expect(csvCell(-4)).toBe('-4');
    expect(csvCell(null)).toBe('');
  });
});

describe('postsCsv', () => {
  it('starts with a BOM and a header, one CRLF row per post, Urdu intact', () => {
    const csv = postsCsv(
      [
        ip({
          postId: 'a',
          content: 'سلام, دنیا 👋',
          impressions: 100,
          engagements: 5,
          engagementRate: 5,
          likes: 5,
          permalink: 'https://x/p',
        }),
      ],
      new Map([[1, { name: 'Asad, Co', platform: 'instagram' }]]),
    );
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(
      'published_at,channel,platform,format,caption,impressions,engagements,engagement_rate,likes,comments,shares,link',
    );
    expect(lines[1]).toBe(
      '2026-09-21T10:00:00.000Z,"Asad, Co",instagram,image,"سلام, دنیا 👋",100,5,5,5,,,https://x/p',
    );
    expect(lines[2]).toBe('');
  });
});
