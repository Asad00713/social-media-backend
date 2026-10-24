import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { WorkspaceRoleService } from '../workspace-members/workspace-role.service';
import { CalendarSyncController } from './calendar-sync.controller';
import { CalendarPushSyncService } from './services/calendar-push-sync.service';
import { ExternalCalendarsService } from './services/external-calendars.service';
import { ExternalEventsService } from './services/external-events.service';

const WS = '11111111-1111-4111-8111-111111111111';
const CALENDAR = {
  id: '22222222-2222-4222-8222-222222222222',
  channelId: 7,
  provider: 'google',
  accountEmail: 'a@example.test',
  name: 'Work',
  color: '#039be5',
  isPrimary: true,
};

describe('CalendarSyncController over HTTP', () => {
  let app: INestApplication<App>;
  const roles = { getRole: jest.fn(), isPlatformSuperAdmin: jest.fn() };
  const calendars = { listCalendarDtos: jest.fn() };
  const events = { listExternalEvents: jest.fn() };
  const push = {
    assertWorkspaceAccess: jest.fn(),
    backfillWorkspace: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CalendarSyncController],
      providers: [
        WorkspaceRoleGuard,
        { provide: WorkspaceRoleService, useValue: roles },
        { provide: ExternalCalendarsService, useValue: calendars },
        { provide: ExternalEventsService, useValue: events },
        { provide: CalendarPushSyncService, useValue: push },
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
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });
  afterAll(() => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    roles.getRole.mockResolvedValue('GUEST');
    roles.isPlatformSuperAdmin.mockResolvedValue(false);
    push.assertWorkspaceAccess.mockResolvedValue(undefined);
    calendars.listCalendarDtos.mockResolvedValue([CALENDAR]);
    events.listExternalEvents.mockResolvedValue([]);
  });

  const base = `/calendar-sync/workspaces/${WS}`;

  it('lets a GUEST list the calendars', async () => {
    await request(app.getHttpServer())
      .get(`${base}/calendars`)
      .expect(200, [CALENDAR]);
    expect(calendars.listCalendarDtos).toHaveBeenCalledWith(WS);
  });

  it('answers 403 to a non-member and reads nothing', async () => {
    roles.getRole.mockResolvedValue(null);
    await request(app.getHttpServer()).get(`${base}/calendars`).expect(403);
    expect(calendars.listCalendarDtos).not.toHaveBeenCalled();
  });

  it('answers 400 to external-events without from', async () => {
    await request(app.getHttpServer())
      .get(`${base}/external-events?to=2026-03-02T00:00:00Z`)
      .expect(400);
    expect(events.listExternalEvents).not.toHaveBeenCalled();
  });
});
