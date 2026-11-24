import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlanFeatureGuard } from './plan-feature.guard';
import type { PlanFeature } from './plan-features';

const WS = '0b6f2a44-6a47-4c1e-9b1e-3f1d2a5c7e01';

function mockContext(
  params: Record<string, string | undefined>,
  user?: { role?: string },
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ params, user }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function mockReflector(feature: PlanFeature | undefined): Reflector {
  return {
    getAllAndOverride: jest.fn().mockReturnValue(feature),
  } as unknown as Reflector;
}

function make(
  feature: PlanFeature | undefined,
  findByWorkspaceId: jest.Mock,
): PlanFeatureGuard {
  return new PlanFeatureGuard(mockReflector(feature), {
    findByWorkspaceId,
  } as never);
}

/** The refusal payload the frontend branches on. */
function refusalOf(err: unknown): Record<string, unknown> {
  expect(err).toBeInstanceOf(ForbiddenException);
  return (err as ForbiddenException).getResponse() as Record<string, unknown>;
}

describe('PlanFeatureGuard', () => {
  it('ignores a route with no @RequiresFeature', async () => {
    const find = jest.fn();
    const guard = make(undefined, find);

    await expect(guard.canActivate(mockContext({}))).resolves.toBe(true);
    // Not merely allowed — it must not even look a plan up, or every ungated
    // route in the app would carry a database query per request.
    expect(find).not.toHaveBeenCalled();
  });

  it('allows a plan that includes the feature', async () => {
    const guard = make(
      'maestro:use',
      jest.fn().mockResolvedValue({ planCode: 'PRO' }),
    );
    await expect(
      guard.canActivate(mockContext({ workspaceId: WS })),
    ).resolves.toBe(true);
  });

  it('refuses a plan below the feature, naming the plan that has it', async () => {
    const guard = make(
      'maestro:use',
      jest.fn().mockResolvedValue({ planCode: 'BASIC' }),
    );

    const err = await guard
      .canActivate(mockContext({ workspaceId: WS }))
      .catch((e: unknown) => e);

    const body = refusalOf(err);
    expect(body.code).toBe('PLAN_FEATURE_REQUIRED');
    expect(body.feature).toBe('maestro:use');
    // The UI says "Available on Pro" from this field rather than keeping its
    // own copy of the map.
    expect(body.requiredPlan).toBe('PRO');
    expect(body.currentPlan).toBe('BASIC');
  });

  it('treats a missing subscription row as FREE and refuses', async () => {
    // Free and never-subscribed accounts have no row. That is an answer, not
    // a failure: the answer is no.
    const guard = make('inbox:use', jest.fn().mockResolvedValue(null));

    const err = await guard
      .canActivate(mockContext({ workspaceId: WS }))
      .catch((e: unknown) => e);

    expect(refusalOf(err).currentPlan).toBe('FREE');
  });

  it('treats an unrecognised plan code as FREE and refuses', async () => {
    const guard = make(
      'inbox:use',
      jest.fn().mockResolvedValue({ planCode: 'GOLD' }),
    );
    await expect(
      guard.canActivate(mockContext({ workspaceId: WS })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows through when the plan lookup THROWS', async () => {
    // The one case that fails open. A database blip must not take a paying
    // customer's Inbox away; a plan gate is revenue protection, not a
    // security boundary. Role and membership guards make the opposite trade.
    const guard = make(
      'inbox:use',
      jest.fn().mockRejectedValue(new Error('connection terminated')),
    );
    await expect(
      guard.canActivate(mockContext({ workspaceId: WS })),
    ).resolves.toBe(true);
  });

  it('exempts a super admin', async () => {
    const find = jest.fn();
    const guard = make('maestro:use', find);

    await expect(
      guard.canActivate(
        mockContext({ workspaceId: WS }, { role: 'SUPER_ADMIN' }),
      ),
    ).resolves.toBe(true);
    expect(find).not.toHaveBeenCalled();
  });

  it('resolves the analytics module’s :wsId spelling', async () => {
    // Every other module uses :workspaceId. Missing this one would make every
    // gated analytics route fail the "no workspace in path" branch.
    const find = jest.fn().mockResolvedValue({ planCode: 'PRO' });
    const guard = make('insights:export', find);

    await expect(guard.canActivate(mockContext({ wsId: WS }))).resolves.toBe(
      true,
    );
    expect(find).toHaveBeenCalledWith(WS);
  });

  it('resolves the lead-ads module’s :wid spelling', async () => {
    // The third spelling. A missed one does not fail open — it lands on the
    // "no workspace in path" branch and refuses EVERY request to that
    // controller, so the whole feature 403s for paying customers too.
    const find = jest.fn().mockResolvedValue({ planCode: 'PRO' });
    const guard = make('ads:use', find);

    await expect(guard.canActivate(mockContext({ wid: WS }))).resolves.toBe(
      true,
    );
    expect(find).toHaveBeenCalledWith(WS);
  });

  it('refuses a gated route with no workspace in its path', async () => {
    // A route that needs a plan feature but is not workspace-scoped is a
    // wiring mistake. Failing open would hide it; refusing surfaces it the
    // first time the route is called.
    const guard = make('inbox:use', jest.fn());
    await expect(guard.canActivate(mockContext({}))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('answers 400, not 403, to a non-uuid workspace id', async () => {
    // A malformed id is a client error, not a plan limitation, and the
    // difference is visible: a 403 saying "upgrade your plan" for a typo in a
    // URL is a lie. Guards run before the route's ParseUUIDPipe, so the guard
    // has to reject the way the pipe would — the controllers' own HTTP specs
    // assert 400 here and caught this when the guard first threw 403.
    const find = jest.fn();
    const guard = make('inbox:use', find);

    const err = await guard
      .canActivate(mockContext({ workspaceId: 'not-a-uuid' }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err).not.toBeInstanceOf(ForbiddenException);
    // And it must not reach Postgres with an invalid uuid, which would be a
    // 500 that reads to the user as the feature being broken.
    expect(find).not.toHaveBeenCalled();
  });
});
