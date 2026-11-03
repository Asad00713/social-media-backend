import type { InsightPost } from './insight-post';
import {
  csvCell,
  filterAndSort,
  formatCountsOf,
  postsCsv,
  tableTotals,
} from './content-table';

const ip = (over: Partial<InsightPost>): InsightPost => ({
  postId: 'p',
  channelId: 1,
  publishedAt: '2026-09-21T10:00:00.000Z',
  title: '',
  content: '',
  format: 'image',
  thumbnailUrl: null,
  permalink: null,
  likes: null,
  comments: null,
  shares: null,
  impressions: null,
  reach: null,
  engagements: 0,
  engagementRate: null,
  imported: false,
  usualMultiplier: null,
  isSettling: false,
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

  it('sorts by reach with unreported reach last, and filters link posts', () => {
    const reached = [
      ip({ postId: 'r1', reach: 50, format: 'link' }),
      ip({ postId: 'r0', reach: null, format: 'link' }),
      ip({ postId: 'r2', reach: 900 }),
    ];
    const order = (o: 'asc' | 'desc') =>
      filterAndSort(reached, { format: 'all', sort: 'reach', order: o }).map(
        (r) => r.postId,
      );
    expect(order('desc')).toEqual(['r2', 'r1', 'r0']);
    expect(order('asc')).toEqual(['r1', 'r2', 'r0']);
    expect(
      filterAndSort(reached, {
        format: 'link',
        sort: 'reach',
        order: 'desc',
      }).map((r) => r.postId),
    ).toEqual(['r1', 'r0']);
  });

  it('a null usual sorts last in both directions', () => {
    const usual = [
      ip({
        postId: 'none-new',
        usualMultiplier: null,
        publishedAt: '2026-09-28T00:00:00.000Z',
      }),
      ip({ postId: 'x2', usualMultiplier: 2.1 }),
      ip({
        postId: 'none-old',
        usualMultiplier: null,
        publishedAt: '2026-09-20T00:00:00.000Z',
      }),
      ip({ postId: 'x05', usualMultiplier: 0.5 }),
      ip({ postId: 'x1', usualMultiplier: 1 }),
    ];
    const order = (o: 'asc' | 'desc') =>
      filterAndSort(usual, { format: 'all', sort: 'usual', order: o }).map(
        (r) => r.postId,
      );
    // Nulls keep the stable tie-break among themselves: newest first.
    expect(order('desc')).toEqual(['x2', 'x1', 'x05', 'none-new', 'none-old']);
    expect(order('asc')).toEqual(['x05', 'x1', 'x2', 'none-new', 'none-old']);
  });
});

describe('formatCountsOf', () => {
  it('counts each pill, every row under all, unknown only there', () => {
    expect(
      formatCountsOf([
        ip({ format: 'image' }),
        ip({ format: 'image' }),
        ip({ format: 'video' }),
        ip({ format: 'link' }),
        ip({ format: 'unknown' }),
      ]),
    ).toEqual({ all: 5, image: 2, video: 1, carousel: 0, link: 1, text: 0 });
  });
  it('is all zeros with no rows', () => {
    expect(formatCountsOf([])).toEqual({
      all: 0,
      image: 0,
      video: 0,
      carousel: 0,
      link: 0,
      text: 0,
    });
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
      'published_at,channel,platform,format,caption,reach,impressions,engagements,engagement_rate,likes,comments,shares,vs_usual,link',
    );
    expect(lines[1]).toBe(
      '2026-09-21T10:00:00.000Z,"Asad, Co",instagram,image,"سلام, دنیا 👋",,100,5,5,5,,,,https://x/p',
    );
    expect(lines[2]).toBe('');
  });

  it('csv has reach and vs_usual and protects a formula in the caption', () => {
    const csv = postsCsv(
      [
        ip({
          content: '=HYPERLINK("https://evil")',
          reach: 80,
          impressions: 120,
          engagements: 9,
          usualMultiplier: 1.35,
        }),
      ],
      new Map([[1, { name: 'shop', platform: 'facebook' }]]),
    );
    const [header, row] = csv.slice(1).split('\r\n');
    const cols = header.split(',');
    const cells = row.split(',');
    expect(cells[cols.indexOf('reach')]).toBe('80');
    expect(cells[cols.indexOf('impressions')]).toBe('120');
    expect(cells[cols.indexOf('vs_usual')]).toBe('1.35');
    expect(cells[cols.indexOf('caption')]).toBe(
      `"'=HYPERLINK(""https://evil"")"`,
    );
  });
});
