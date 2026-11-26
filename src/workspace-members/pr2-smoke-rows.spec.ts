import 'reflect-metadata';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AiController } from '../ai/ai.controller';
import { BrandKitController } from '../brand-kit/brand-kit.controller';
import { ConversationsController } from '../inbox/conversations/conversations.controller';
import { LabelsController } from '../labels/labels.controller';
import { MediaLibraryController } from '../media-library/media-library.controller';
import { PlannerController } from '../planner/planner.controller';
import { PostCommentsController } from '../post-comments/post-comments.controller';
import { ComposerController } from '../posts/composer/composer.controller';
import type { WorkspaceRole } from './role-capabilities';
import { WorkspaceRoleGuard } from './workspace-role.guard';
import type { WorkspaceRoleService } from './workspace-role.service';

// The PR 2 HTTP smoke could not boot an app (no local Redis), so this drives
// the REAL WorkspaceRoleGuard, with a REAL Reflector, against the REAL handler
// of each smoke route and a role. It pins what the HTTP smoke would have shown
// for the guard layer: a Viewer's reads answer through, a Viewer's writes are
// refused with the 403, a Member's draft write goes through.

type Ctor = new (...args: never[]) => object;

function ctxFor(controller: Ctor, handler: string): ExecutionContext {
  const proto = controller.prototype as Record<string, () => unknown>;
  return {
    getClass: () => controller,
    getHandler: () => proto[handler],
    switchToHttp: () => ({
      getRequest: () => ({
        user: { userId: 'u' },
        params: { workspaceId: 'w' },
      }),
    }),
  } as unknown as ExecutionContext;
}

function guardFor(role: WorkspaceRole): WorkspaceRoleGuard {
  const roles = {
    getRole: jest.fn().mockResolvedValue(role),
    isPlatformSuperAdmin: jest.fn().mockResolvedValue(false),
  } as unknown as WorkspaceRoleService;
  return new WorkspaceRoleGuard(new Reflector(), roles);
}

const GUEST_ANSWERS: Array<[string, Ctor, string]> = [
  ['planner list', PlannerController, 'list'],
  ['library list (items)', MediaLibraryController, 'getMediaItems'],
  ['library list (categories)', MediaLibraryController, 'getCategories'],
  ['brand-kit GET', BrandKitController, 'get'],
  ['post comment GET', PostCommentsController, 'list'],
  ['post comment POST', PostCommentsController, 'create'],
  [
    'inbox conversation read (no-write branch)',
    ConversationsController,
    'read',
  ],
];

const GUEST_REFUSED: Array<[string, Ctor, string]> = [
  ['composer PUT draft', ComposerController, 'saveDraft'],
  ['AI generate', AiController, 'generatePost'],
  ['label POST', LabelsController, 'create'],
];

describe('PR 2 smoke rows: the capability guard per route and role', () => {
  it.each(GUEST_ANSWERS)('GUEST: %s passes the guard', async (_n, c, h) => {
    await expect(guardFor('GUEST').canActivate(ctxFor(c, h))).resolves.toBe(
      true,
    );
  });

  it.each(GUEST_REFUSED)('GUEST: %s is refused with 403', async (_n, c, h) => {
    await expect(
      guardFor('GUEST').canActivate(ctxFor(c, h)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each(GUEST_REFUSED)('MEMBER: %s passes the guard', async (_n, c, h) => {
    await expect(guardFor('MEMBER').canActivate(ctxFor(c, h))).resolves.toBe(
      true,
    );
  });
});
