/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- Reflect metadata reads */
import 'reflect-metadata';
import { REQUIRE_CAPABILITY } from './require-capability.decorator';
import { WorkspaceRoleGuard } from './workspace-role.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdsController } from '../ads/ads.controller';
import { LeadAdsController } from '../ads/lead-ads.controller';
import { AiController } from '../ai/ai.controller';
import { BillingController } from '../billing/billing.controller';
import { CommunityController } from '../community/community.controller';
import { CanvaComposerController } from '../canva/canva-composer.controller';
import { NotificationRoutesController } from '../notifications/notification-routes.controller';
import { InboxController } from '../inbox/inbox.controller';
import { MediaLibraryController } from '../media-library/media-library.controller';
import { MediaSourcesController } from '../media-sources/media-sources.controller';
import { ChannelsController } from '../channels/channels.controller';

type Cap =
  | 'posts:draft'
  | 'posts:publish'
  | 'analytics:view'
  | 'channels:manage'
  | 'inbox:view'
  | 'inbox:reply'
  | 'team:view'
  | 'billing:manage';

// Every route of these controllers and the capability it must demand. null means
// the route is deliberately not workspace-gated (public, OAuth callback, webhook,
// user-scoped, or a proxy with no workspace in the path). A route missing from a
// table, or carrying a different capability, fails the spec.
const EXPECTED: Array<[string, new (...a: any[]) => object, Record<string, Cap | null>]> = [
  [
    'AdsController',
    AdsController,
    {
      list: 'analytics:view',
      postsForBoost: 'analytics:view',
      getBoost: 'analytics:view',
      getCampaignInsights: 'analytics:view',
      listCampaigns: 'analytics:view',
      listLeads: 'analytics:view',
      searchInterests: 'analytics:view',
      searchGeoLocations: 'analytics:view',
      searchLanguages: 'analytics:view',
      searchBehaviors: 'analytics:view',
      searchDemographics: 'analytics:view',
      getDeliveryEstimate: 'analytics:view',
      listDrafts: 'posts:draft',
      upsertDraft: 'posts:draft',
      getDraft: 'posts:draft',
      deleteDraft: 'posts:draft',
      sync: 'channels:manage',
      createBoost: 'channels:manage',
      editBoost: 'channels:manage',
      createLeadCampaign: 'channels:manage',
      updateCampaignStatus: 'channels:manage',
      updateAdSetBudget: 'channels:manage',
    },
  ],
  [
    'LeadAdsController',
    LeadAdsController,
    {
      listRoutes: 'channels:manage',
      createRoute: 'channels:manage',
      updateRoute: 'channels:manage',
      deleteRoute: 'channels:manage',
      testWebhook: 'channels:manage',
    },
  ],
  [
    'AiController',
    AiController,
    {
      getStatus: null,
      getOptions: null,
      getSttInfo: null,
      getWorkspaceUsage: 'analytics:view',
      suggestReply: 'inbox:reply',
      generatePost: 'posts:draft',
      generateCaption: 'posts:draft',
      generateHashtags: 'posts:draft',
      generateIdeas: 'posts:draft',
      generateYouTubeMetadata: 'posts:draft',
      repurposeContent: 'posts:draft',
      improvePost: 'posts:draft',
      generateThread: 'posts:draft',
      generateBio: 'posts:draft',
      translateContent: 'posts:draft',
      generateVariations: 'posts:draft',
      generateCaptionVariants: 'posts:draft',
      generatePerChannel: 'posts:draft',
      analyzePost: 'posts:draft',
      transcribeAudio: 'posts:draft',
    },
  ],
  [
    'BillingController',
    BillingController,
    {
      pauseSubscription: null,
      resumeSubscription: null,
      getUserWorkspaceLimits: null,
      getAllPlans: null,
      getUserBillingSummary: null,
      getUserInvoices: null,
      getInvoiceDetails: null,
      getInvoicePdf: null,
      getPaymentMethods: null,
      addPaymentMethod: null,
      setDefaultPaymentMethod: null,
      removePaymentMethod: null,
      createSetupIntent: null,
      syncPaymentMethods: null,
      handleStripeWebhook: null,
      handleLemonSqueezyWebhook: null,
      getSubscription: 'team:view',
      getWorkspaceUsage: 'team:view',
      resetBillingState: 'billing:manage',
      createSubscription: 'billing:manage',
      createCheckoutSession: 'billing:manage',
      cancelSubscription: 'billing:manage',
      recalculateUsage: 'billing:manage',
      getAvailableAddons: 'team:view',
      getCurrentAddons: 'team:view',
      purchaseAddon: 'billing:manage',
      removeAddon: 'billing:manage',
      getPlansForWorkspace: 'team:view',
      previewPlanChange: 'billing:manage',
      changePlan: 'billing:manage',
      downgradeToFree: 'billing:manage',
      getWorkspaceDashboard: 'billing:manage',
      getSubscriptionHistory: 'billing:manage',
      getWorkspaceInvoices: 'billing:manage',
      getUpcomingInvoice: 'billing:manage',
    },
  ],
  [
    'CommunityController',
    CommunityController,
    {
      getSupportedPlatforms: null,
      getPostComments: 'inbox:view',
      getFullPostComments: 'inbox:view',
      getMentions: 'inbox:view',
      createReply: 'inbox:reply',
    },
  ],
  [
    'CanvaComposerController',
    CanvaComposerController,
    {
      status: 'posts:draft',
      designs: 'posts:draft',
      import: 'posts:draft',
      disconnect: 'channels:manage',
    },
  ],
  [
    'NotificationRoutesController',
    NotificationRoutesController,
    {
      list: 'team:view',
      create: 'channels:manage',
      update: 'channels:manage',
      delete: 'channels:manage',
    },
  ],
  [
    'InboxController',
    InboxController,
    {
      listComments: 'inbox:view',
      mentions: 'inbox:view',
      getThread: 'inbox:view',
      markThreadRead: 'inbox:view',
      getCounts: 'inbox:view',
      getWebhookStatus: 'inbox:view',
      listDmConversations: 'inbox:view',
      getDmThread: 'inbox:view',
      markDmRead: 'inbox:view',
      listScheduled: 'inbox:view',
      scheduledCounts: 'inbox:view',
      getScheduled: 'inbox:view',
      reply: 'inbox:reply',
      commentOnPost: 'inbox:reply',
      updateStatus: 'inbox:reply',
      hide: 'inbox:reply',
      updateThreadStatus: 'inbox:reply',
      syncNow: 'inbox:reply',
      sendDm: 'inbox:reply',
      sendDmTemplate: 'inbox:reply',
      createScheduled: 'inbox:reply',
      updateScheduled: 'inbox:reply',
      cancelScheduled: 'inbox:reply',
      createUploadUrl: 'inbox:reply',
      deleteComment: 'inbox:reply',
      deleteDm: 'inbox:reply',
      archiveDmConversation: 'inbox:reply',
      archiveCommentThread: 'inbox:reply',
    },
  ],
  [
    'MediaLibraryController',
    MediaLibraryController,
    {
      createCategory: 'posts:draft',
      getCategories: 'posts:draft',
      getCategoriesGrouped: 'posts:draft',
      getCategory: 'posts:draft',
      updateCategory: 'posts:draft',
      deleteCategory: 'posts:draft',
      reorderCategories: 'posts:draft',
      createMediaItem: 'posts:draft',
      getMediaItems: 'posts:draft',
      getRecentMediaItems: 'posts:draft',
      getMediaItem: 'posts:draft',
      updateMediaItem: 'posts:draft',
      deleteMediaItem: 'posts:draft',
      restoreMediaItem: 'posts:draft',
      recordMediaItemUsage: 'posts:draft',
      bulkActionMediaItems: 'posts:draft',
      createTemplate: 'posts:draft',
      getTemplates: 'posts:draft',
      getTemplate: 'posts:draft',
      updateTemplate: 'posts:draft',
      cloneTemplate: 'posts:draft',
      deleteTemplate: 'posts:draft',
      restoreTemplate: 'posts:draft',
      recordTemplateUsage: 'posts:draft',
      createTextSnippet: 'posts:draft',
      getTextSnippets: 'posts:draft',
      getTextSnippet: 'posts:draft',
      updateTextSnippet: 'posts:draft',
      deleteTextSnippet: 'posts:draft',
      restoreTextSnippet: 'posts:draft',
      recordTextSnippetUsage: 'posts:draft',
      createSavedLink: 'posts:draft',
      getSavedLinks: 'posts:draft',
      getSavedLink: 'posts:draft',
      updateSavedLink: 'posts:draft',
      refreshLinkPreview: 'posts:draft',
      deleteSavedLink: 'posts:draft',
      restoreSavedLink: 'posts:draft',
      recordSavedLinkUsage: 'posts:draft',
      getRecycleBin: 'posts:draft',
      permanentDeleteMediaItem: 'posts:publish',
      permanentDeleteTemplate: 'posts:publish',
      permanentDeleteTextSnippet: 'posts:publish',
      permanentDeleteSavedLink: 'posts:publish',
      emptyRecycleBin: 'posts:publish',
    },
  ],
  [
    'MediaSourcesController',
    MediaSourcesController,
    {
      browse: 'posts:draft',
      import: 'posts:draft',
    },
  ],
  [
    'ChannelsController',
    ChannelsController,
    {
      getWorkspaceChannels: 'posts:draft',
      getChannel: 'posts:draft',
      getChannelStats: 'analytics:view',
      getExpiringChannels: 'analytics:view',
      listPinterestBoardsForChannel: 'posts:draft',
      listRedditSubreddits: 'posts:draft',
      listRedditFlairs: 'posts:draft',
      createPinterestBoard: 'channels:manage',
      updatePinterestBoard: 'channels:manage',
      deletePinterestBoard: 'channels:manage',
      createPinterestPin: 'posts:publish',
      uploadYouTubeVideo: 'posts:publish',
      getYouTubeVideoStatus: 'posts:draft',
      createLinkedInPost: 'posts:publish',
      getTikTokProfile: 'posts:draft',
      getTikTokVideos: 'analytics:view',
      getTikTokCreatorInfo: 'posts:draft',
      postTikTokVideo: 'posts:publish',
      getTikTokPublishStatus: 'posts:publish',
      waitForTikTokPublish: 'posts:publish',
      listSlackConversations: 'inbox:view',
      listSlackMembers: 'inbox:view',
      joinSlackChannel: 'posts:publish',
      startSlackDm: 'posts:publish',
      createSlackChannel: 'channels:manage',
      listDiscordChannels: 'inbox:view',
      sendDiscordChannelMessage: 'posts:publish',
      createDiscordChannel: 'channels:manage',
      initiateOAuth: 'channels:manage',
      oauthConnectError: null,
      oauthConnectSuccess: null,
      oauthCallback: null,
      completeOAuth: 'channels:manage',
      updateChannel: 'channels:manage',
      deleteChannel: 'channels:manage',
      deleteYoutubeData: 'channels:manage',
      reorderChannels: 'channels:manage',
      refreshToken: 'channels:manage',
      reconnectChannel: 'channels:manage',
      forceConnected: 'channels:manage',
      getFacebookPages: null,
      debugFacebookToken: null,
      connectFacebookPage: 'channels:manage',
      getFacebookUser: null,
      connectPinterest: 'channels:manage',
      getPinterestUser: null,
      getPinterestBoards: null,
      connectYouTube: 'channels:manage',
      getYouTubeChannel: null,
      getYouTubePlaylists: null,
      getYouTubeCategories: null,
      connectLinkedIn: 'channels:manage',
      getLinkedInProfile: null,
      getLinkedInOrganizations: null,
      connectTikTok: 'channels:manage',
      connectTwitter: 'channels:manage',
      getTwitterProfile: null,
      getTwitterTweets: null,
      initiateTwitterOAuth1: 'channels:manage',
      twitterOAuth1Callback: null,
      connectInstagram: 'channels:manage',
      getInstagramProfileWithToken: null,
      connectInstagramWithUserToken: 'channels:manage',
      getInstagramProfile: null,
      getInstagramMedia: null,
      getInstagramInsights: null,
      postImageToInstagram: null,
      postVideoToInstagram: null,
      postCarouselToInstagram: null,
      postStoryToInstagram: null,
      postStoryToFacebook: null,
      instagramDeauthorize: null,
      connectThreads: 'channels:manage',
      getThreadsProfile: null,
      getThreadsPosts: null,
      getThreadInsights: null,
      postTextToThreads: null,
      postImageToThreads: null,
      postVideoToThreads: null,
      postCarouselToThreads: null,
      threadsDeauthorize: null,
      connectBluesky: 'channels:manage',
      getBlueskyProfile: null,
      getBlueskyPosts: null,
      refreshBlueskySession: null,
      postTextToBluesky: null,
      postImageToBluesky: null,
      postVideoToBluesky: null,
      postLinkToBluesky: null,
      deleteBlueskyPost: null,
      initiateMastodonOAuth: 'channels:manage',
      mastodonOAuthCallback: null,
      getMastodonProfile: null,
      getMastodonPosts: null,
      postTextToMastodon: null,
      postImageToMastodon: null,
      postVideoToMastodon: null,
      deleteMastodonPost: null,
      getMastodonInstanceInfo: null,
      connectGoogleDrive: 'channels:manage',
      getDriveFile: null,
      getDriveUserInfo: null,
      verifyDriveAccess: null,
      connectGooglePhotos: 'channels:manage',
      listPhotosMedia: null,
      listPhotosOnly: null,
      listPhotosVideos: null,
      listPhotosAlbums: null,
      getPhotosMediaItem: null,
      verifyPhotosAccess: null,
      listCalendars: null,
      getPrimaryCalendar: null,
      listCalendarEvents: null,
      createCalendarEvent: null,
      createPostCalendarEvent: null,
      updateCalendarEvent: null,
      deleteCalendarEvent: null,
      getCalendarEvent: null,
      markEventPublished: null,
      markEventFailed: null,
      verifyCalendarAccess: null,
      listOutlookCalendars: null,
      getOutlookPrimaryCalendar: null,
      listOutlookCalendarEvents: null,
      createOutlookCalendarEvent: null,
      createOutlookPostCalendarEvent: null,
      updateOutlookCalendarEvent: null,
      deleteOutlookCalendarEvent: null,
      getOutlookCalendarEvent: null,
      markOutlookEventPublished: null,
      markOutlookEventFailed: null,
      verifyOutlookCalendarAccess: null,
      connectOneDrive: 'channels:manage',
      getOneDriveUserInfo: null,
      listOneDriveMedia: null,
      listOneDriveImages: null,
      listOneDriveVideos: null,
      listOneDriveFolders: null,
      searchOneDrive: null,
      getOneDriveItem: null,
      getOneDriveDownloadUrl: null,
      verifyOneDriveAccess: null,
      connectDropbox: 'channels:manage',
      getDropboxUserInfo: null,
      getDropboxSpaceUsage: null,
      listDropboxFolder: null,
      listDropboxMedia: null,
      listDropboxImages: null,
      listDropboxVideos: null,
      listDropboxFolders: null,
      searchDropbox: null,
      getDropboxMetadata: null,
      getDropboxDownloadLink: null,
      verifyDropboxAccess: null,
      searchUnsplashPhotos: null,
      getRandomUnsplashPhotos: null,
      getCuratedUnsplashPhotos: null,
      getUnsplashPhoto: null,
      trackUnsplashDownload: null,
      connectTelegramBot: 'channels:manage',
      getWhatsAppEmbeddedSignupConfig: null,
      connectWhatsApp: 'channels:manage',
      connectWhatsAppEmbeddedSignup: 'channels:manage',
    },
  ],
];

const WS_PARAM = /:(workspaceId|wsId|wid)/;

function routePath(ctrl: object, handler: (...a: any[]) => unknown): string {
  const base = Reflect.getMetadata('path', ctrl) as string | string[];
  const sub = Reflect.getMetadata('path', handler) as string | string[];
  const b = Array.isArray(base) ? base[0] : base;
  const s = Array.isArray(sub) ? sub[0] : sub;
  return `/${b ?? ''}/${s ?? ''}`;
}

function guardsOf(ctrl: object, handler: object): unknown[] {
  return [
    ...((Reflect.getMetadata('__guards__', ctrl) as unknown[]) ?? []),
    ...((Reflect.getMetadata('__guards__', handler) as unknown[]) ?? []),
  ];
}

describe.each(EXPECTED)('%s workspace guard', (_name, Ctrl, expected) => {
  const proto = Ctrl.prototype as Record<string, (...a: any[]) => unknown>;
  const handlers = Object.getOwnPropertyNames(proto).filter(
    (n) => n !== 'constructor' && Reflect.getMetadata('path', proto[n]) !== undefined,
  );

  it('covers every route handler, none missing from the table', () => {
    expect(handlers.sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))('%s requires %s', (handler, cap) => {
    const actual = (Reflect.getMetadata(REQUIRE_CAPABILITY, proto[handler]) ??
      Reflect.getMetadata(REQUIRE_CAPABILITY, Ctrl)) as Cap | undefined;
    expect(actual ?? null).toBe(cap);
    if (cap) {
      expect(guardsOf(Ctrl, proto[handler])).toContain(WorkspaceRoleGuard);
      expect(guardsOf(Ctrl, proto[handler])).toContain(JwtAuthGuard);
    }
  });

  it('every route with a workspace path param carries a capability', () => {
    const open = handlers.filter(
      (n) => WS_PARAM.test(routePath(Ctrl, proto[n])) && expected[n] === null,
    );
    expect(open).toEqual([]);
  });
});
