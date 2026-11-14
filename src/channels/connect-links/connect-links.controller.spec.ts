import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ChannelsController } from '../channels.controller';
import { ChannelsModule } from '../channels.module';
import { ConnectLinksController } from './connect-links.controller';

describe('ConnectLinksController', () => {
  it('lives under channels/workspaces/:workspaceId/connect-links', () => {
    expect(Reflect.getMetadata('path', ConnectLinksController)).toBe(
      'channels/workspaces/:workspaceId/connect-links',
    );
  });

  it('is registered before ChannelsController, so `connect-links` is not read as a channel id', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      ChannelsModule,
    ) as unknown[];
    expect(controllers.indexOf(ConnectLinksController)).toBeGreaterThanOrEqual(
      0,
    );
    expect(controllers.indexOf(ConnectLinksController)).toBeLessThan(
      controllers.indexOf(ChannelsController),
    );
  });
});
