/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await -- test doubles are loosely typed */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ApprovalPolicy } from '../../../drizzle/schema/workspace.schema';
import type { WorkspaceRole } from '../../../workspace-members/role-capabilities';
import {
  assertPolicyAllowsDirectSend,
  newApprovalRequest,
  readApproval,
} from '../../lib/draft-approval';
import { ApprovalPolicyService, policyCovers } from './approval-policy.service';

const ROLES: WorkspaceRole[] = ['OWNER', 'ADMIN', 'MEMBER', 'GUEST'];

describe('policyCovers', () => {
  it.each<[ApprovalPolicy, boolean[]]>([
    ['members', [false, false, true, true]],
    // The OWNER is never covered (controller ruling), even under everyone.
    ['everyone', [false, true, true, true]],
    ['none', [false, false, false, false]],
  ])('%s covers OWNER, ADMIN, MEMBER, GUEST as %j', (policy, expected) => {
    expect(ROLES.map((r) => policyCovers(policy, r))).toEqual(expected);
  });

  it('never covers a platform super admin or a non-member', () => {
    for (const policy of ['none', 'members', 'everyone'] as const) {
      expect(policyCovers(policy, 'SUPER_ADMIN')).toBe(false);
      expect(policyCovers(policy, null)).toBe(false);
    }
  });
});

describe('ApprovalPolicyService.coversAuthor', () => {
  function build(policy: ApprovalPolicy | null, role: WorkspaceRole | null) {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (policy ? [{ approvalPolicy: policy }] : []),
          }),
        }),
      }),
    };
    const roles = { getRole: jest.fn(async () => role) };
    return { svc: new ApprovalPolicyService(db as any, roles as any), roles };
  }

  it('reads the policy and the author role', async () => {
    const { svc, roles } = build('members', 'MEMBER');
    await expect(svc.coversAuthor('ws-1', 'u-1')).resolves.toBe(true);
    expect(roles.getRole).toHaveBeenCalledWith('ws-1', 'u-1');
  });

  it('is false for an admin under members', async () => {
    await expect(
      build('members', 'ADMIN').svc.coversAuthor('ws-1', 'u-1'),
    ).resolves.toBe(false);
  });

  it('skips the role lookup under none', async () => {
    const { svc, roles } = build('none', 'MEMBER');
    await expect(svc.coversAuthor('ws-1', 'u-1')).resolves.toBe(false);
    expect(roles.getRole).not.toHaveBeenCalled();
  });

  it('is false for a workspace that does not exist', async () => {
    await expect(
      build(null, 'MEMBER').svc.coversAuthor('ws-1', 'u-1'),
    ).resolves.toBe(false);
  });

  it('assertMayActivate refuses a covered person with the policy 403', async () => {
    const err = await build('members', 'MEMBER')
      .svc.assertMayActivate('ws-1', 'u-1')
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toEqual({
      statusCode: 403,
      error: 'Forbidden',
      code: 'APPROVAL_REQUIRED_BY_POLICY',
      message:
        'Your workspace needs approval before posts go out. Ask an admin to launch this.',
    });
  });

  it('assertMayActivate lets an uncovered person through', async () => {
    await expect(
      build('members', 'ADMIN').svc.assertMayActivate('ws-1', 'u-1'),
    ).resolves.toBeUndefined();
    await expect(
      build('everyone', 'OWNER').svc.assertMayActivate('ws-1', 'u-1'),
    ).resolves.toBeUndefined();
  });
});

describe('policy approvals in metadata', () => {
  it('newApprovalRequest marks a policy request; readApproval keeps both keys', () => {
    const request = newApprovalRequest('u1', new Date(0), { byPolicy: true });
    expect(request).toMatchObject({ required: true, byPolicy: true });
    const read = readApproval({
      approval: { ...request, notifiedAt: '2026-11-17T10:00:00.000Z' },
    });
    expect(read).toMatchObject({
      byPolicy: true,
      notifiedAt: '2026-11-17T10:00:00.000Z',
    });
  });

  it('a plain request has neither key', () => {
    const read = readApproval({ approval: newApprovalRequest('u1') });
    expect(read).not.toHaveProperty('byPolicy');
    expect(read).not.toHaveProperty('notifiedAt');
  });
});

describe('assertPolicyAllowsDirectSend', () => {
  const codeOf = (fn: () => void): unknown => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      return ((e as BadRequestException).getResponse() as { code: string })
        .code;
    }
    return null;
  };

  it('refuses a covered author with no stored approval', () => {
    expect(codeOf(() => assertPolicyAllowsDirectSend(true, undefined))).toBe(
      'APPROVAL_REQUIRED',
    );
    expect(
      codeOf(() => assertPolicyAllowsDirectSend(true, { title: 'x' })),
    ).toBe('APPROVAL_REQUIRED');
  });

  it('lets a stored approval through to assertApprovedFor', () => {
    expect(
      codeOf(() =>
        assertPolicyAllowsDirectSend(true, {
          approval: newApprovalRequest('u1'),
        }),
      ),
    ).toBeNull();
  });

  it('never refuses an author the policy does not cover', () => {
    expect(codeOf(() => assertPolicyAllowsDirectSend(false, null))).toBeNull();
  });
});
