import 'reflect-metadata';
import { REQUIRE_CAPABILITY } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ShortLinkRedirectController } from './short-link-redirect.controller';
import { ShortLinksController } from './short-links.controller';

type Cap = 'posts:draft';

// Every route of ShortLinksController and the capability it must demand. A
// route missing from this table, or carrying a different capability, fails
// the spec. (The global net in every-workspace-route-guarded.spec.ts only
// checks that SOME capability is declared; this pins which one.)
const EXPECTED: Record<string, Cap> = {
  create: 'posts:draft',
  list: 'posts:draft',
};

const routeHandlers = (proto: Record<string, object>): string[] =>
  Object.getOwnPropertyNames(proto).filter(
    (n) =>
      n !== 'constructor' &&
      Reflect.getMetadata('path', proto[n]) !== undefined,
  );

describe('ShortLinksController workspace guard', () => {
  const proto = ShortLinksController.prototype as unknown as Record<
    string,
    object
  >;
  const guards = (handler: object): unknown[] => [
    ...((Reflect.getMetadata(
      '__guards__',
      ShortLinksController,
    ) as unknown[]) ?? []),
    ...((Reflect.getMetadata('__guards__', handler) as unknown[]) ?? []),
  ];

  it('covers every route handler, none missing from the table', () => {
    expect(routeHandlers(proto).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s requires %s', (handler, cap) => {
    expect(Reflect.getMetadata(REQUIRE_CAPABILITY, proto[handler])).toBe(cap);
    expect(guards(proto[handler])).toContain(JwtAuthGuard);
    expect(guards(proto[handler])).toContain(WorkspaceRoleGuard);
  });
});

describe('ShortLinkRedirectController is public', () => {
  const proto = ShortLinkRedirectController.prototype as unknown as Record<
    string,
    object
  >;

  it('has exactly one route, GET /l/:code, with no guard at all', () => {
    expect(routeHandlers(proto)).toEqual(['redirect']);
    expect(Reflect.getMetadata('path', ShortLinkRedirectController)).toBe('l');
    expect(Reflect.getMetadata('path', proto.redirect)).toBe(':code');
    expect(
      Reflect.getMetadata('__guards__', ShortLinkRedirectController),
    ).toBeUndefined();
    expect(Reflect.getMetadata('__guards__', proto.redirect)).toBeUndefined();
  });
});
