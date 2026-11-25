import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ChannelsController } from './channels.controller';
import { MastodonService } from './services/mastodon.service';

// POST channels/mastodon/instance had no guard and fetched whatever URL the
// caller named (SSRF through our server). Nothing in the app called it, so the
// route and the service method behind it are gone.
describe('ChannelsController has no Mastodon instance lookup', () => {
  const proto = ChannelsController.prototype as unknown as Record<
    string,
    object
  >;
  const routes = Object.getOwnPropertyNames(proto)
    .filter((n) => n !== 'constructor' && typeof proto[n] === 'function')
    .filter(
      (n) =>
        Reflect.getMetadata(PATH_METADATA, proto[n]) !== undefined &&
        Reflect.getMetadata(METHOD_METADATA, proto[n]) !== undefined,
    )
    .map((n) => ({
      handler: n,
      path: String(Reflect.getMetadata(PATH_METADATA, proto[n])),
      method: Reflect.getMetadata(METHOD_METADATA, proto[n]) as RequestMethod,
    }));

  it('enumerates a plausible number of routes', () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  it('has no POST mastodon/instance route', () => {
    const hits = routes.filter(
      (r) =>
        r.method === RequestMethod.POST && /mastodon\/instance/.test(r.path),
    );
    expect(hits).toEqual([]);
  });

  it('has no route at all that mentions mastodon/instance', () => {
    expect(routes.filter((r) => /mastodon\/instance/.test(r.path))).toEqual([]);
  });

  it('MastodonService no longer exposes an unauthenticated instance fetch', () => {
    expect(
      (MastodonService.prototype as unknown as Record<string, unknown>)
        .getInstanceInfo,
    ).toBeUndefined();
  });
});
