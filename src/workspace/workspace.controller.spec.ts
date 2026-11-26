import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { Capability } from '../workspace-members/role-capabilities';
import { REQUIRE_CAPABILITY } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import type { CloudflareR2Service } from '../media/cloudflare-r2.service';
import { WorkspaceController } from './workspace.controller';
import type { WorkspaceService } from './workspace.service';

// The workspace-scoped General routes and the capability each must demand.
// The route param is :workspaceId so WorkspaceRoleGuard can resolve it.
const GUARDED: Record<string, { cap: Capability; path: string }> = {
  findOne: { cap: 'settings:view', path: ':workspaceId' },
  update: { cap: 'workspace:manage', path: ':workspaceId' },
  presignLogo: { cap: 'workspace:manage', path: ':workspaceId/logo/presign' },
  publishingDefaults: {
    cap: 'posts:view',
    path: ':workspaceId/publishing-defaults',
  },
  deletionPreview: {
    cap: 'workspace:delete',
    path: ':workspaceId/deletion-preview',
  },
  removePermanently: {
    cap: 'workspace:delete',
    path: ':workspaceId/permanent',
  },
};

describe('WorkspaceController guards', () => {
  const proto = WorkspaceController.prototype as unknown as Record<
    string,
    object
  >;
  const guards = (handler: object): unknown[] => [
    ...((Reflect.getMetadata(
      GUARDS_METADATA,
      WorkspaceController,
    ) as unknown[]) ?? []),
    ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ?? []),
  ];

  it.each(Object.entries(GUARDED))(
    '%s requires its capability behind JwtAuthGuard and WorkspaceRoleGuard',
    (handler, { cap }) => {
      expect(Reflect.getMetadata(REQUIRE_CAPABILITY, proto[handler])).toBe(cap);
      expect(guards(proto[handler])).toContain(JwtAuthGuard);
      expect(guards(proto[handler])).toContain(WorkspaceRoleGuard);
    },
  );

  it.each(Object.entries(GUARDED))('%s is routed at its path', (handler, g) => {
    const actual = Reflect.getMetadata('path', proto[handler]) as string;
    expect(actual.replace(/^\//, '')).toBe(g.path);
  });

  it('registers slug/:slug before every :workspaceId/... GET', () => {
    // Nest registers in declaration order: a workspace whose slug is
    // literally `publishing-defaults` must not be shadowed.
    const names = Object.getOwnPropertyNames(proto);
    expect(names.indexOf('findBySlug')).toBeLessThan(
      names.indexOf('publishingDefaults'),
    );
    expect(names.indexOf('findBySlug')).toBeLessThan(names.indexOf('findOne'));
  });

  it('keeps the slug lookup owner-only: no workspace id in its path', () => {
    expect(
      Reflect.getMetadata(REQUIRE_CAPABILITY, proto.findBySlug),
    ).toBeUndefined();
    expect(guards(proto.findBySlug)).not.toContain(WorkspaceRoleGuard);
  });

  it('presignLogo answers 200 like the avatar presign', () => {
    expect(Reflect.getMetadata('__httpCode__', proto.presignLogo)).toBe(200);
  });
});

describe('WorkspaceController behaviour', () => {
  function make() {
    const detail = { id: 'ws-1', name: 'Acme', ownerName: 'Owner' };
    const service = {
      findDetail: jest.fn().mockResolvedValue(detail),
      getPublishingDefaults: jest.fn().mockResolvedValue({
        approvalPolicy: 'none',
        shortenLinksDefault: false,
        utmDefault: false,
      }),
      update: jest.fn().mockResolvedValue({
        // The raw row, secrets included: the controller must never return it.
        workspace: {
          id: 'ws-1',
          maestroAnthropicKey: 'enc',
          inviteLinkCode: 'x',
        },
        timezoneMove: null,
      }),
      deletionPreview: jest.fn().mockResolvedValue({ channels: 2 }),
      remove: jest
        .fn()
        .mockResolvedValue({ message: 'Workspace permanently deleted' }),
    };
    const r2 = {
      createPresignedUpload: jest.fn().mockResolvedValue({ key: 'k' }),
    };
    const controller = new WorkspaceController(
      service as unknown as WorkspaceService,
      r2 as unknown as CloudflareR2Service,
    );
    return { controller, service, r2, detail };
  }
  const user = { userId: 'user-1', email: 'a@example.test' };

  it('findOne answers the detail', async () => {
    const { controller, service, detail } = make();
    await expect(controller.findOne('ws-1')).resolves.toEqual({
      success: true,
      data: detail,
    });
    expect(service.findDetail).toHaveBeenCalledWith('ws-1');
  });

  it('update answers the detail, never the raw row, plus timezoneMove', async () => {
    const { controller, service, detail } = make();
    const res = await controller.update('ws-1', { name: 'Acme' });
    expect(service.update).toHaveBeenCalledWith('ws-1', { name: 'Acme' });
    expect(res).toEqual({
      success: true,
      message: 'Workspace updated successfully',
      data: detail,
      timezoneMove: null,
    });
    expect(JSON.stringify(res)).not.toContain('maestroAnthropicKey');
    expect(JSON.stringify(res)).not.toContain('inviteLinkCode');
  });

  it('publishingDefaults answers the three switches', async () => {
    const { controller } = make();
    await expect(controller.publishingDefaults('ws-1')).resolves.toEqual({
      approvalPolicy: 'none',
      shortenLinksDefault: false,
      utmDefault: false,
    });
  });

  it('presignLogo asks R2 for a workspace-logo upload for this workspace and user', async () => {
    const { controller, r2 } = make();
    await controller.presignLogo(
      'ws-1',
      { contentType: 'image/png', sizeBytes: 1024, filename: 'l.png' },
      user,
    );
    expect(r2.createPresignedUpload).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      userId: 'user-1',
      kind: 'workspace-logo',
      contentType: 'image/png',
      sizeBytes: 1024,
      filename: 'l.png',
    });
  });

  it('deletionPreview answers the service counts as they are', async () => {
    const { controller, service } = make();
    await expect(controller.deletionPreview('ws-1')).resolves.toEqual({
      channels: 2,
    });
    expect(service.deletionPreview).toHaveBeenCalledWith('ws-1');
  });

  it('removePermanently passes the typed name and the caller to the service', async () => {
    const { controller, service } = make();
    await expect(
      controller.removePermanently('ws-1', user, { confirmName: 'Acme' }),
    ).resolves.toEqual({
      success: true,
      message: 'Workspace permanently deleted',
    });
    expect(service.remove).toHaveBeenCalledWith('ws-1', 'user-1', 'Acme');
  });
});
