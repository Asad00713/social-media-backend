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
  ])('changes when %s changes', (_what, over) => {
    expect(
      contentFingerprint(content(over as Partial<ApprovableContent>)),
    ).not.toBe(contentFingerprint(content()));
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
