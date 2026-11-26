import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { Capability } from '../workspace-members/role-capabilities';
import { REQUIRE_CAPABILITY } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { LabelsController } from './labels.controller';

// Every route of LabelsController and the capability it must demand (spec
// §5.9). A route missing from this table, or carrying a different
// capability, fails the spec. Handler names are the ones Task 22 asserts.
const EXPECTED: Record<string, Capability> = {
  list: 'posts:view',
  create: 'labels:manage',
  update: 'labels:manage',
  merge: 'labels:manage',
  remove: 'labels:manage',
  restore: 'labels:manage',
};

describe('LabelsController workspace guard', () => {
  const proto = LabelsController.prototype as unknown as Record<string, object>;
  const handlers = Object.getOwnPropertyNames(proto).filter(
    (n) =>
      n !== 'constructor' &&
      Reflect.getMetadata('path', proto[n]) !== undefined,
  );
  const guards = (handler: object): unknown[] => [
    ...((Reflect.getMetadata(GUARDS_METADATA, LabelsController) as unknown[]) ??
      []),
    ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ?? []),
  ];

  it('is mounted at labels/workspaces/:workspaceId', () => {
    expect(Reflect.getMetadata('path', LabelsController)).toBe(
      'labels/workspaces/:workspaceId',
    );
  });

  it('covers every route handler, none missing from the table', () => {
    expect([...handlers].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s requires %s', (handler, cap) => {
    expect(Reflect.getMetadata(REQUIRE_CAPABILITY, proto[handler])).toBe(cap);
    expect(guards(proto[handler])).toContain(JwtAuthGuard);
    expect(guards(proto[handler])).toContain(WorkspaceRoleGuard);
  });

  it.each([
    ['list', ''],
    ['create', ''],
    ['update', ':labelId'],
    ['merge', ':labelId/merge'],
    ['remove', ':labelId'],
    ['restore', ':labelId/restore'],
  ])('%s is routed at "%s"', (handler, path) => {
    const actual = Reflect.getMetadata('path', proto[handler]) as string;
    expect(actual.replace(/^\//, '')).toBe(path);
  });

  it('create answers 201', () => {
    expect(Reflect.getMetadata('__httpCode__', proto.create)).toBe(201);
  });
});
