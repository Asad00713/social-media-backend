import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlanFeatureGuard } from '../billing/plan/plan-feature.guard';
import { SubscriptionLookupService } from '../billing/services/subscription-lookup.service';
import { CloudflareR2Service } from '../media/cloudflare-r2.service';
import { REQUIRE_CAPABILITY } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import { CommentActionsService } from './conversations/services/comment-actions.service';
import { ReplyResponseBuilder } from './conversations/services/reply-response.builder';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { ScheduledMessagesService } from './services/scheduled-messages.service';

const WS = '11111111-1111-4111-8111-111111111111';

// Read state is shared across the workspace (there is no per-user read row),
// so a role that cannot reply opens a thread without clearing it for the team.
describe('inbox thread and DM read routes over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const inbox = {
    markThreadRead: jest.fn(),
    markDmConversationRead: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InboxController],
      providers: [
        PlanFeatureGuard,
        {
          provide: SubscriptionLookupService,
          useValue: {
            findByWorkspaceId: () => Promise.resolve({ planCode: 'MAX' }),
          },
        },
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: InboxService, useValue: inbox },
        { provide: CommentActionsService, useValue: {} },
        { provide: ReplyResponseBuilder, useValue: {} },
        { provide: ScheduledMessagesService, useValue: {} },
        { provide: CloudflareR2Service, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => { getRequest: () => { user?: unknown } };
        }) => {
          ctx.switchToHttp().getRequest().user = { userId: 'user-1' };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });
  afterAll(() => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    roles.getRole.mockResolvedValue('GUEST');
    roles.isPlatformSuperAdmin.mockResolvedValue(false);
    inbox.markThreadRead.mockResolvedValue({ updatedCount: 3 });
    inbox.markDmConversationRead.mockResolvedValue({ updatedCount: 2 });
  });

  const base = `/inbox/workspaces/${WS}`;
  const routes = [
    ['thread', `${base}/threads/5:abc/read`, 'markThreadRead'],
    ['DM', `${base}/dms/dm-1/read`, 'markDmConversationRead'],
  ] as const;

  it.each(['markThreadRead', 'markDmRead'] as const)(
    '%s stays on inbox:view, so a Viewer can still open the thread',
    (name) => {
      expect(
        Reflect.getMetadata(
          REQUIRE_CAPABILITY,
          InboxController.prototype[name],
        ),
      ).toBe('inbox:view');
    },
  );

  describe.each(routes)('%s read', (_label, path, method) => {
    it('a GUEST marking a thread or DM read gets { updatedCount: 0 } and the service is not called', async () => {
      await request(app.getHttpServer())
        .post(path)
        .expect(200, { updatedCount: 0 });
      expect(inbox[method]).not.toHaveBeenCalled();
    });

    it('a MEMBER marking read still writes', async () => {
      roles.getRole.mockResolvedValue('MEMBER');
      await request(app.getHttpServer())
        .post(path)
        .expect(200, { updatedCount: method === 'markThreadRead' ? 3 : 2 });
      expect(inbox[method]).toHaveBeenCalledTimes(1);
    });

    it('a platform super admin still writes', async () => {
      roles.getRole.mockResolvedValue(null);
      roles.isPlatformSuperAdmin.mockResolvedValue(true);
      await request(app.getHttpServer()).post(path).expect(200);
      expect(inbox[method]).toHaveBeenCalledTimes(1);
    });

    it('a non-member is still refused', async () => {
      roles.getRole.mockResolvedValue(null);
      await request(app.getHttpServer()).post(path).expect(403);
      expect(inbox[method]).not.toHaveBeenCalled();
    });
  });
});
