import { BadRequestException } from '@nestjs/common';
import {
  approvalState,
  assertApprovedFor,
  canonicalJson,
  carryApproval,
  contentFingerprint,
  newApprovalRequest,
  readApproval,
  withoutApproval,
  type ApprovableContent,
} from './draft-approval';

const content = (over: Partial<ApprovableContent> = {}): ApprovableContent => ({
  content: 'Iced latte is back',
  mediaItems: [{ url: 'https://cdn.test/a.jpg', type: 'image' }],
  platformContent: {
    instagram: {
      inheritsFromBase: false,
      overrides: { text: 'IG copy' },
      platformSpecific: { shareToFeed: true },
    },
  },
  targets: [
    { channelId: '7', platform: 'instagram' } as { channelId: string },
    { channelId: '9', platform: 'x' } as { channelId: string },
  ],
  metadata: { hashtags: ['coffee'], firstComment: 'Link in bio' },
  ...over,
});

const approvedFor = (c: ApprovableContent) => ({
  approval: {
    ...newApprovalRequest('member-1', new Date('2026-11-01T10:00:00Z')),
    approvedById: 'admin-1',
    approvedAt: '2026-11-01T11:00:00.000Z',
    approvedFingerprint: contentFingerprint(c),
  },
});

const codeOf = (fn: () => void): unknown => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return ((e as BadRequestException).getResponse() as { code: string }).code;
  }
  return null;
};

describe('canonicalJson', () => {
  it('sorts keys at every depth, so jsonb key order does not matter', () => {
    expect(
      canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }),
    ).toBe('{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
  });

  it('drops undefined keys, as JSON does', () => {
    expect(canonicalJson({ a: undefined, b: 'x' })).toBe('{"b":"x"}');
  });
});

describe('contentFingerprint', () => {
  it('is the same for the same content with keys in another order', () => {
    const a = content();
    const b = JSON.parse(
      JSON.stringify({
        targets: a.targets,
        platformContent: {
          instagram: {
            platformSpecific: { shareToFeed: true },
            overrides: { text: 'IG copy' },
            inheritsFromBase: false,
          },
        },
        mediaItems: [{ type: 'image', url: 'https://cdn.test/a.jpg' }],
        content: a.content,
        metadata: { firstComment: 'Link in bio', hashtags: ['coffee'] },
      }),
    ) as ApprovableContent;
    expect(contentFingerprint(b)).toBe(contentFingerprint(a));
  });

  it('ignores channel order and per-channel delivery state', () => {
    const a = content();
    const b = content({
      targets: [
        { channelId: '9', status: 'publishing' },
        { channelId: 7, publishStatus: 'queued' },
      ] as unknown as ApprovableContent['targets'],
    });
    expect(contentFingerprint(b)).toBe(contentFingerprint(a));
  });

  it.each([
    ['the caption', { content: 'Iced latte is back!' }],
    ['the media', { mediaItems: [{ url: 'https://cdn.test/b.jpg' }] }],
    [
      'a channel setting',
      {
        platformContent: {
          instagram: {
            inheritsFromBase: false,
            overrides: { text: 'IG copy' },
            platformSpecific: { shareToFeed: false },
          },
        },
      },
    ],
    ['the channels', { targets: [{ channelId: '7' }] }],
    [
      'a legacy first comment',
      { metadata: { hashtags: ['coffee'], firstComment: 'Buy now' } },
    ],
    [
      'the hashtags',
      { metadata: { hashtags: ['tea'], firstComment: 'Link in bio' } },
    ],
    [
      'a legacy title (no composer marker)',
      {
        metadata: {
          hashtags: ['coffee'],
          firstComment: 'Link in bio',
          title: 'New title',
        },
      },
    ],
    [
      'a repeat rule added',
      {
        metadata: {
          hashtags: ['coffee'],
          firstComment: 'Link in bio',
          schedule: {
            mode: 'all_same_time',
            recurrence: { freq: 'daily', interval: 1, ends: { type: 'never' } },
          },
        },
      },
    ],
    [
      'a TikTok flag',
      {
        metadata: {
          hashtags: ['coffee'],
          firstComment: 'Link in bio',
          brandContentToggle: true,
        },
      },
    ],
  ])('changes when %s changes', (_what, over) => {
    expect(
      contentFingerprint(content(over as Partial<ApprovableContent>)),
    ).not.toBe(contentFingerprint(content()));
  });

  it('a different rotating wording changes it; the variation index does not', () => {
    const withSources = (text: string, index: number) =>
      content({
        metadata: {
          hashtags: ['coffee'],
          firstComment: 'Link in bio',
          schedule: {
            recurrence: {
              freq: 'daily',
              interval: 1,
              ends: { type: 'never' },
              rotateVariations: true,
              seriesId: 's1',
              occurrence: index + 1,
              anchorDate: '2026-11-01',
              time: '09:00',
              variations: { x: { text, index } },
            },
          },
        },
      });
    expect(contentFingerprint(withSources('{a|b}', 1))).toBe(
      contentFingerprint(withSources('{a|b}', 0)),
    );
    expect(contentFingerprint(withSources('{a|c}', 0))).not.toBe(
      contentFingerprint(withSources('{a|b}', 0)),
    );
  });

  it.each([
    [
      'the time it goes out',
      {
        schedule: { mode: 'all_same_time', scheduleAt: '2026-12-01T09:00:00Z' },
      },
    ],
    ['its campaign and labels', { campaignId: 'c1', labels: ['x'] }],
    ['its approval', { approval: { required: true } }],
    ['a publish report', { mediaWarning: 'Some media was left out' }],
    [
      'the composer marker and its draft name',
      { source: 'composer', title: 'My draft' },
    ],
    ['the a-time-per-channel family', { scheduleGroupId: 'g1' }],
  ])('does not change with %s', (_what, extra) => {
    const base = { hashtags: ['coffee'], firstComment: 'Link in bio' };
    expect(
      contentFingerprint(content({ metadata: { ...base, ...extra } })),
    ).toBe(contentFingerprint(content({ metadata: base })));
  });

  it("a series' place and anchor do not change it, its rule does", () => {
    const rule = { freq: 'weekly', interval: 1, ends: { type: 'never' } };
    const at = (occurrence: number, interval = 1) =>
      contentFingerprint(
        content({
          metadata: {
            hashtags: ['coffee'],
            firstComment: 'Link in bio',
            schedule: {
              recurrence: {
                ...rule,
                interval,
                seriesId: 's',
                occurrence,
                anchorDate: '2026-11-0' + occurrence,
                time: '09:00',
              },
            },
          },
        }),
      );
    expect(at(2)).toBe(at(1));
    expect(at(1, 2)).not.toBe(at(1));
  });

  it('a row with no covered metadata keeps its pre-metadata fingerprint', () => {
    // Grants made before metadata was covered stay valid for such rows.
    const bare = content({ metadata: { approval: { required: true } } });
    const { metadata: _m, ...rest } = bare;
    void _m;
    const legacy = contentFingerprint({ ...rest, metadata: undefined });
    expect(contentFingerprint(bare)).toBe(legacy);
  });
});

describe('readApproval', () => {
  it('is null without a request', () => {
    expect(readApproval(null)).toBeNull();
    expect(readApproval({ title: 'x' })).toBeNull();
    expect(readApproval({ approval: { required: false } })).toBeNull();
  });

  it('reads a stored request', () => {
    const meta = { approval: newApprovalRequest('u1', new Date(0)) };
    expect(readApproval(meta)).toEqual({
      required: true,
      requestedById: 'u1',
      requestedAt: '1970-01-01T00:00:00.000Z',
      approvedById: null,
      approvedAt: null,
      approvedFingerprint: null,
    });
  });
});

describe('assertApprovedFor', () => {
  it('lets a post that needs no approval through', () => {
    expect(codeOf(() => assertApprovedFor({}, content()))).toBeNull();
    expect(codeOf(() => assertApprovedFor(undefined, content()))).toBeNull();
  });

  it('refuses a pending request with APPROVAL_REQUIRED', () => {
    const meta = { approval: newApprovalRequest('u1') };
    expect(codeOf(() => assertApprovedFor(meta, content()))).toBe(
      'APPROVAL_REQUIRED',
    );
  });

  it('refuses content that changed after the grant with APPROVAL_STALE', () => {
    const meta = approvedFor(content());
    expect(
      codeOf(() => assertApprovedFor(meta, content({ content: 'edited' }))),
    ).toBe('APPROVAL_STALE');
  });

  it('lets exactly the approved content through', () => {
    expect(
      codeOf(() => assertApprovedFor(approvedFor(content()), content())),
    ).toBeNull();
  });
});

describe('carryApproval', () => {
  it('carries nothing for a post that needs no approval', () => {
    expect(carryApproval({ title: 'x' }, content())).toEqual({});
  });

  it('keeps a grant while the content is unchanged', () => {
    const meta = approvedFor(content());
    expect(carryApproval(meta, content())).toEqual(meta);
  });

  it('withdraws the grant, but keeps the request, when the content changed', () => {
    const meta = approvedFor(content());
    const carried = carryApproval(meta, content({ content: 'edited' }));
    expect(carried.approval).toEqual({
      ...meta.approval,
      approvedById: null,
      approvedAt: null,
      approvedFingerprint: null,
    });
    expect(
      approvalState(carried.approval!, contentFingerprint(content())),
    ).toBe('pending');
  });
});

describe('approvalState', () => {
  it('none / pending / approved', () => {
    const fp = contentFingerprint(content());
    expect(approvalState(null, fp)).toBe('none');
    expect(approvalState(newApprovalRequest('u1'), fp)).toBe('pending');
    expect(approvalState(approvedFor(content()).approval, fp)).toBe('approved');
    expect(approvalState(approvedFor(content()).approval, 'other')).toBe(
      'pending',
    );
  });
});

describe('withoutApproval', () => {
  it('removes a client-supplied approval and keeps the rest', () => {
    expect(
      withoutApproval({ title: 't', approval: { required: true } }),
    ).toEqual({ title: 't' });
    expect(withoutApproval(undefined)).toBeUndefined();
  });
});
