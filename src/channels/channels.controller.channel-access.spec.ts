import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ChannelsController } from './channels.controller';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

/**
 * The body-`channelId` routes have no workspace in the path, so they were
 * reachable by any logged-in user holding a numeric channel id. Each must now
 * assert the caller's capability on the CHANNEL's own workspace.
 */
const CHANNEL_WS = 'ws-of-the-channel';
const user = { userId: 'user-1', email: 'u@example.com' };

type Cap = 'posts:publish' | 'analytics:view' | 'channels:manage';
const ROUTES: Array<[string, Cap]> = [
  ['getTwitterProfile', 'analytics:view'],
  ['getTwitterTweets', 'analytics:view'],
  ['getMastodonProfile', 'analytics:view'],
  ['getMastodonPosts', 'analytics:view'],
  ['refreshBlueskySession', 'channels:manage'],
  ['postImageToInstagram', 'posts:publish'],
  ['postVideoToInstagram', 'posts:publish'],
  ['postCarouselToInstagram', 'posts:publish'],
  ['postStoryToInstagram', 'posts:publish'],
  ['postStoryToFacebook', 'posts:publish'],
  ['postTextToThreads', 'posts:publish'],
  ['postImageToThreads', 'posts:publish'],
  ['postVideoToThreads', 'posts:publish'],
  ['postCarouselToThreads', 'posts:publish'],
  ['postTextToBluesky', 'posts:publish'],
  ['postImageToBluesky', 'posts:publish'],
  ['postVideoToBluesky', 'posts:publish'],
  ['postLinkToBluesky', 'posts:publish'],
  ['deleteBlueskyPost', 'posts:publish'],
  ['postTextToMastodon', 'posts:publish'],
  ['postImageToMastodon', 'posts:publish'],
  ['postVideoToMastodon', 'posts:publish'],
  ['deleteMastodonPost', 'posts:publish'],
];

function build(assertCan: jest.Mock) {
  const controller: any = Object.create(ChannelsController.prototype);
  controller.channelService = {
    // A TikTok channel: every handler's platform check then throws
    // BadRequest, which proves the access check passed and the handler ran on.
    getChannelForPosting: jest.fn().mockResolvedValue({
      id: 7,
      workspaceId: CHANNEL_WS,
      platform: 'tiktok',
    }),
  };
  controller.access = { assertCan };
  return controller;
}

describe('ChannelsController body-channelId routes', () => {
  it.each(ROUTES)(
    '%s: non-member gets NotFound before the channel is used',
    async (name) => {
      const assertCan = jest.fn().mockRejectedValue(new NotFoundException());
      const c = build(assertCan);
      await expect(c[name](user, { channelId: 7 })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    },
  );

  it.each(ROUTES)(
    '%s: asserts %s on the channel workspace',
    async (name, cap) => {
      const assertCan = jest.fn().mockResolvedValue('MEMBER');
      const c = build(assertCan);
      await expect(c[name](user, { channelId: 7 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(assertCan).toHaveBeenCalledWith(CHANNEL_WS, 'user-1', cap);
    },
  );

  it('no handler loads a channel by bare id outside the access helper', () => {
    const src = readFileSync(join(__dirname, 'channels.controller.ts'), 'utf8');
    expect(src.match(/getChannelForPosting\(/g)).toHaveLength(1);
  });

  it('every route still sits behind JwtAuthGuard', () => {
    for (const [name] of ROUTES) {
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        (ChannelsController.prototype as any)[name],
      );
      expect(guards).toContain(JwtAuthGuard);
    }
  });
});
