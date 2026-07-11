import { BadRequestException } from '@nestjs/common';
import { ChannelsController } from './channels.controller';

/**
 * Focused unit tests for the Google Drive / Google Photos "connect" routes
 * added to fix the bug where connecting these cloud sources in the composer
 * never created a `socialMediaChannels` row (unlike Dropbox/OneDrive, which
 * already had dedicated connect routes).
 *
 * The controller has a large (26-param) constructor with heavy DI, so rather
 * than standing up a full Nest TestingModule we instantiate the controller
 * directly, passing real mocks only for the services these two methods touch
 * (`channelService`, `googleDriveService`, `googlePhotosService`) and `{}`
 * casts for every other dependency, which these methods never call.
 */
describe('ChannelsController - cloud storage connect routes', () => {
  const workspaceId = 'workspace-123';
  const user = { userId: 'user-1', email: 'user@example.com' };

  function buildController(overrides?: {
    createChannel?: jest.Mock;
    getUserInfo?: jest.Mock;
    verifyAccess?: jest.Mock;
  }) {
    const createChannel =
      overrides?.createChannel ??
      jest.fn().mockResolvedValue({ id: 1, platform: 'google_drive' });

    const channelService = { createChannel } as any;

    const googleDriveService = {
      getUserInfo:
        overrides?.getUserInfo ??
        jest
          .fn()
          .mockResolvedValue({ email: 'a@b.com', displayName: 'A' }),
    } as any;

    const googlePhotosService = {
      verifyAccess: overrides?.verifyAccess ?? jest.fn().mockResolvedValue(true),
    } as any;

    const noop = {} as any;

    const controller = new ChannelsController(
      channelService, // channelService
      noop, // oauthService
      noop, // facebookService
      noop, // pinterestService
      noop, // youtubeService
      noop, // linkedinService
      noop, // tiktokService
      noop, // twitterService
      noop, // instagramService
      noop, // threadsService
      noop, // blueskyService
      noop, // mastodonService
      noop, // slackService
      noop, // discordService
      googleDriveService, // googleDriveService
      googlePhotosService, // googlePhotosService
      noop, // googleCalendarService
      noop, // oneDriveService
      noop, // dropboxService
      noop, // unsplashService
      noop, // redditService
      noop, // adAccountsService
      noop, // slackBackfill
      noop, // inboxService
      noop, // telegramConnectService
      noop, // telegramService
      noop, // whatsappService
      noop, // whatsappOnboardingService
    );

    return { controller, createChannel, googleDriveService, googlePhotosService };
  }

  describe('connectGoogleDrive', () => {
    it('creates a storage channel from Google Drive user info and returns it', async () => {
      const { controller, createChannel } = buildController();

      const result = await controller.connectGoogleDrive(
        workspaceId,
        user,
        { accessToken: 'token-abc' } as any,
      );

      expect(createChannel).toHaveBeenCalledTimes(1);
      const [calledWorkspaceId, calledUserId, payload] =
        createChannel.mock.calls[0];
      expect(calledWorkspaceId).toBe(workspaceId);
      expect(calledUserId).toBe(user.userId);
      expect(payload).toMatchObject({
        platform: 'google_drive',
        accountType: 'storage',
        platformAccountId: 'a@b.com',
        accountName: 'A',
      });

      expect(result).toEqual({
        channel: { id: 1, platform: 'google_drive' },
        message: 'Google Drive connected successfully',
      });
    });
  });

  describe('connectGooglePhotos', () => {
    it('rejects with BadRequestException and does not create a channel when access cannot be verified', async () => {
      const verifyAccess = jest.fn().mockResolvedValue(false);
      const { controller, createChannel } = buildController({ verifyAccess });

      await expect(
        controller.connectGooglePhotos(workspaceId, user, {
          accessToken: 'token-abc',
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(createChannel).not.toHaveBeenCalled();
    });

    it('creates a storage channel keyed by workspace when access is verified', async () => {
      const { controller, createChannel } = buildController();

      const result = await controller.connectGooglePhotos(
        workspaceId,
        user,
        { accessToken: 'token-abc' } as any,
      );

      expect(createChannel).toHaveBeenCalledTimes(1);
      const [, , payload] = createChannel.mock.calls[0];
      expect(payload).toMatchObject({
        platform: 'google_photos',
        accountType: 'storage',
        platformAccountId: `google_photos:${workspaceId}`,
        accountName: 'Google Photos',
      });

      expect(result).toEqual({
        channel: { id: 1, platform: 'google_drive' },
        message: 'Google Photos connected successfully',
      });
    });
  });
});
