import { Test, TestingModule } from '@nestjs/testing';
import { AuthGuard } from '@nestjs/passport';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './services/analytics.service';
import { ChannelOwnershipGuard } from './guards/channel-ownership.guard';
import { DRIZZLE } from '../../drizzle/drizzle.module';

describe('AnalyticsController', () => {
  let controller: AnalyticsController;
  const fakeService = { getOverview: jest.fn(), getSyncState: jest.fn(), requestManualRefresh: jest.fn() };
  const fakeDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ platform: 'youtube' }],
        }),
      }),
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [
        { provide: AnalyticsService, useValue: fakeService },
        { provide: DRIZZLE, useValue: fakeDb },
      ],
    })
      .overrideGuard(AuthGuard('jwt')).useValue({ canActivate: () => true })
      .overrideGuard(ChannelOwnershipGuard).useValue({ canActivate: () => true })
      .compile();

    controller = module.get(AnalyticsController);
  });

  it('getOverview delegates to service with parsed channelId + platform + range', async () => {
    fakeService.getOverview.mockResolvedValue({ stub: true });
    const result = await controller.getOverview('ws-1', '42', '30d');
    expect(fakeService.getOverview).toHaveBeenCalledWith(42, 'youtube', '30d');
    expect(result).toEqual({ stub: true });
  });

  it('getOverview rejects invalid range', async () => {
    await expect(controller.getOverview('ws-1', '42', 'invalid' as any))
      .rejects.toThrow(/Invalid range/);
  });

  it('getSyncState delegates to service', async () => {
    fakeService.getSyncState.mockResolvedValue({ ok: true });
    const result = await controller.getSyncState('ws-1', '42');
    expect(fakeService.getSyncState).toHaveBeenCalledWith(42);
    expect(result).toEqual({ ok: true });
  });
});
