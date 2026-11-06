/* eslint-disable @typescript-eslint/no-unsafe-argument -- Reflect metadata reads */
import 'reflect-metadata';
import { REQUIRE_CAPABILITY } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BrandKitController } from './brand-kit.controller';

type Cap = 'brand:manage' | 'posts:draft';

// Every route of BrandKitController and the capability it must demand. A route missing
// from this table, or carrying a different capability, fails the spec. (The
// global net in every-workspace-route-guarded.spec.ts only checks that SOME
// capability is declared; this pins which one.)
const EXPECTED: Record<string, Cap> = {
  get: 'posts:draft',
  update: 'brand:manage',
};

describe('BrandKitController workspace guard', () => {
  const proto = BrandKitController.prototype as unknown as Record<
    string,
    object
  >;
  const handlers = Object.getOwnPropertyNames(proto).filter(
    (n) =>
      n !== 'constructor' &&
      Reflect.getMetadata('path', proto[n]) !== undefined,
  );
  const guards = (handler: object): unknown[] => [
    ...((Reflect.getMetadata('__guards__', BrandKitController) as unknown[]) ??
      []),
    ...((Reflect.getMetadata('__guards__', handler) as unknown[]) ?? []),
  ];

  it('covers every route handler, none missing from the table', () => {
    expect(handlers.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s requires %s', (handler, cap) => {
    expect(Reflect.getMetadata(REQUIRE_CAPABILITY, proto[handler])).toBe(cap);
    expect(guards(proto[handler])).toContain(JwtAuthGuard);
    expect(guards(proto[handler])).toContain(WorkspaceRoleGuard);
  });
});
