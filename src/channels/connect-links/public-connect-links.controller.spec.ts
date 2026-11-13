import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { SKIP_LAUNCH_GATE } from '../../auth/decorators/skip-launch-gate.decorator';
import { ClientIpThrottlerGuard } from './client-ip-throttler.guard';
import type { ConnectLinkConnectService } from './connect-link-connect.service';
import type { ConnectLinkAccessService } from './connect-link-access.service';
import { PublicConnectLinksController } from './public-connect-links.controller';

const proto = PublicConnectLinksController.prototype as unknown as Record<
  string,
  object
>;

describe('PublicConnectLinksController - Facebook Pages routes', () => {
  it('sit on the throttled, launch-gate-free public controller', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, PublicConnectLinksController),
    ).toContain(ClientIpThrottlerGuard);
    expect(
      Reflect.getMetadata(SKIP_LAUNCH_GATE, PublicConnectLinksController),
    ).toBe(true);
  });

  it.each([
    ['facebookPages', RequestMethod.GET, ':token/facebook/pages', undefined],
    ['connectFacebook', RequestMethod.POST, ':token/facebook/connect', 201],
  ])('%s is %s %s', (name, method, path, code) => {
    const handler = proto[name];
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(code);
  });

  it('passes the token and the selection / body through', async () => {
    const facebookPages = jest.fn().mockResolvedValue([]);
    const connectFacebook = jest
      .fn()
      .mockResolvedValue({ channels: [], skipped: [] });
    const controller = new PublicConnectLinksController(
      {} as ConnectLinkAccessService,
      {
        facebookPages,
        connectFacebook,
      } as unknown as ConnectLinkConnectService,
    );
    await controller.facebookPages('tok', 'sel');
    expect(facebookPages).toHaveBeenCalledWith('tok', 'sel');
    const body = { selection: 'sel', pageIds: ['1'], includeInstagram: true };
    await controller.connectFacebook('tok', body);
    expect(connectFacebook).toHaveBeenCalledWith('tok', body);
  });
});
