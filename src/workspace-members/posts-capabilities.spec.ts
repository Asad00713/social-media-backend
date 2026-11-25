import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { REQUIRE_CAPABILITY } from './require-capability.decorator';
import { AdsController } from '../ads/ads.controller';
import { AiController } from '../ai/ai.controller';
import { ComposerAssistController } from '../ai/composer-assist.controller';
import { BrandKitController } from '../brand-kit/brand-kit.controller';
import { CalendarSyncController } from '../calendar-sync/calendar-sync.controller';
import { CampaignsController } from '../campaigns/campaigns.controller';
import { CanvaComposerController } from '../canva/canva-composer.controller';
import { ChannelHubController } from '../channels/channel-hub.controller';
import { ChannelPageController } from '../channels/channel-page/channel-page.controller';
import { ChannelsController } from '../channels/channels.controller';
import { DripController } from '../drips/drip.controller';
import { LabelsController } from '../labels/labels.controller';
import { MediaLibraryController } from '../media-library/media-library.controller';
import { MediaSourcesController } from '../media-sources/media-sources.controller';
import { PlannerBestTimesController } from '../planner/planner-best-times.controller';
import { PlannerNotesController } from '../planner/planner-notes.controller';
import { PlannerPreferencesController } from '../planner/planner-preferences.controller';
import { PlannerQueueController } from '../planner/planner-queue.controller';
import { PlannerController } from '../planner/planner.controller';
import { PostCommentsController } from '../post-comments/post-comments.controller';
import { ComposerController } from '../posts/composer/composer.controller';
import { PostsController } from '../posts/posts.controller';
import { ShortLinksController } from '../short-links/short-links.controller';
import { WorkspaceController } from '../workspace/workspace.controller';

type PostsCap = 'posts:view' | 'posts:draft' | 'posts:comment';
type Controller = new (...a: any[]) => object;
type Row = [Controller, string, PostsCap];

// Every route that used to be `@RequireCapability('posts:draft')` (144 rows),
// with the capability it demands under the Viewer-is-read-only policy:
//  - a READ takes posts:view (GUEST), so a Viewer's Planner, Library, brand
//    kit and labels keep answering 200;
//  - a WRITE keeps posts:draft, which is now MEMBER;
//  - post comments take posts:comment (GUEST), resolve/reopen included;
//  - the composer-only lookups that spend platform quota or make the server
//    fetch a URL (channels lookups, Canva designs, composer link-preview,
//    media-sources browse) are posts:draft even though they read.
// A route missing here, or tagged differently, fails the spec.
const ROWS: Row[] = [
  // ads/ads.controller.ts
  [AdsController, 'listDrafts', 'posts:view'],
  [AdsController, 'upsertDraft', 'posts:draft'],
  [AdsController, 'getDraft', 'posts:view'],
  [AdsController, 'deleteDraft', 'posts:draft'],
  // ai/ai.controller.ts
  [AiController, 'generatePost', 'posts:draft'],
  [AiController, 'generateCaption', 'posts:draft'],
  [AiController, 'generateHashtags', 'posts:draft'],
  [AiController, 'generateIdeas', 'posts:draft'],
  [AiController, 'generateYouTubeMetadata', 'posts:draft'],
  [AiController, 'repurposeContent', 'posts:draft'],
  [AiController, 'improvePost', 'posts:draft'],
  [AiController, 'generateThread', 'posts:draft'],
  [AiController, 'generateBio', 'posts:draft'],
  [AiController, 'translateContent', 'posts:draft'],
  [AiController, 'generateVariations', 'posts:draft'],
  [AiController, 'generateCaptionVariants', 'posts:draft'],
  [AiController, 'generatePerChannel', 'posts:draft'],
  [AiController, 'analyzePost', 'posts:draft'],
  [AiController, 'transcribeAudio', 'posts:draft'],
  // ai/composer-assist.controller.ts
  [ComposerAssistController, 'finish', 'posts:draft'],
  [ComposerAssistController, 'fitChannels', 'posts:draft'],
  [ComposerAssistController, 'fromLink', 'posts:draft'],
  [ComposerAssistController, 'fillBlanks', 'posts:draft'],
  // brand-kit/brand-kit.controller.ts
  [BrandKitController, 'get', 'posts:view'],
  // calendar-sync/calendar-sync.controller.ts
  [CalendarSyncController, 'listExternalEvents', 'posts:view'],
  [CalendarSyncController, 'listCalendars', 'posts:view'],
  // campaigns/campaigns.controller.ts
  [CampaignsController, 'statusCounts', 'posts:view'],
  [CampaignsController, 'spans', 'posts:view'],
  [CampaignsController, 'list', 'posts:view'],
  [CampaignsController, 'getOne', 'posts:view'],
  // canva/canva-composer.controller.ts
  [CanvaComposerController, 'status', 'posts:view'],
  [CanvaComposerController, 'designs', 'posts:draft'],
  [CanvaComposerController, 'createDesign', 'posts:draft'],
  [CanvaComposerController, 'import', 'posts:draft'],
  // channels/channel-hub.controller.ts
  [ChannelHubController, 'summary', 'posts:view'],
  // channels/channel-page/channel-page.controller.ts
  [ChannelPageController, 'getPage', 'posts:view'],
  [ChannelPageController, 'listPosts', 'posts:view'],
  // channels/channels.controller.ts
  [ChannelsController, 'getWorkspaceChannels', 'posts:view'],
  [ChannelsController, 'getChannel', 'posts:view'],
  [ChannelsController, 'lookupMention', 'posts:draft'],
  [ChannelsController, 'listPinterestBoardsForChannel', 'posts:draft'],
  [ChannelsController, 'listYouTubePlaylistsForChannel', 'posts:draft'],
  [ChannelsController, 'listPinterestBoardSectionsForChannel', 'posts:draft'],
  [ChannelsController, 'listFacebookPagesForChannel', 'posts:draft'],
  [ChannelsController, 'listRedditSubreddits', 'posts:draft'],
  [ChannelsController, 'listRedditFlairs', 'posts:draft'],
  [ChannelsController, 'getYouTubeVideoStatus', 'posts:draft'],
  [ChannelsController, 'getTikTokProfile', 'posts:draft'],
  [ChannelsController, 'getTikTokCreatorInfo', 'posts:draft'],
  // drips/drip.controller.ts
  [DripController, 'getWorkspaceDripCampaigns', 'posts:view'],
  [DripController, 'getWorkspaceScheduledDripPosts', 'posts:view'],
  [DripController, 'getDripCampaign', 'posts:view'],
  [DripController, 'getDripPosts', 'posts:view'],
  [DripController, 'getDripPost', 'posts:view'],
  [DripController, 'getCampaignHistory', 'posts:view'],
  [DripController, 'getCampaignStats', 'posts:view'],
  // labels/labels.controller.ts
  [LabelsController, 'list', 'posts:view'],
  // media-library/media-library.controller.ts
  [MediaLibraryController, 'getLibraryStats', 'posts:view'],
  [MediaLibraryController, 'createCategory', 'posts:draft'],
  [MediaLibraryController, 'getCategories', 'posts:view'],
  [MediaLibraryController, 'getCategoriesGrouped', 'posts:view'],
  [MediaLibraryController, 'getCategory', 'posts:view'],
  [MediaLibraryController, 'updateCategory', 'posts:draft'],
  [MediaLibraryController, 'deleteCategory', 'posts:draft'], // Task 5 moves this to posts:publish
  [MediaLibraryController, 'reorderCategories', 'posts:draft'],
  [MediaLibraryController, 'createCategoryZipTicket', 'posts:view'],
  [MediaLibraryController, 'createMediaItem', 'posts:draft'],
  [MediaLibraryController, 'getMediaItems', 'posts:view'],
  [MediaLibraryController, 'getRecentMediaItems', 'posts:view'],
  [MediaLibraryController, 'getMediaItem', 'posts:view'],
  [MediaLibraryController, 'generateAltTextForUrl', 'posts:draft'],
  [MediaLibraryController, 'generateMediaItemAltText', 'posts:draft'],
  [MediaLibraryController, 'updateMediaItem', 'posts:draft'],
  [MediaLibraryController, 'deleteMediaItem', 'posts:draft'],
  [MediaLibraryController, 'restoreMediaItem', 'posts:draft'],
  [MediaLibraryController, 'recordMediaItemUsage', 'posts:draft'],
  [MediaLibraryController, 'getMediaItemUsage', 'posts:view'],
  [MediaLibraryController, 'bulkActionMediaItems', 'posts:draft'],
  [MediaLibraryController, 'createTemplate', 'posts:draft'],
  [MediaLibraryController, 'getTemplates', 'posts:view'],
  [MediaLibraryController, 'bulkTemplates', 'posts:draft'],
  [MediaLibraryController, 'getTemplate', 'posts:view'],
  [MediaLibraryController, 'updateTemplate', 'posts:draft'],
  [MediaLibraryController, 'cloneTemplate', 'posts:draft'],
  [MediaLibraryController, 'deleteTemplate', 'posts:draft'],
  [MediaLibraryController, 'restoreTemplate', 'posts:draft'],
  [MediaLibraryController, 'recordTemplateUsage', 'posts:draft'],
  [MediaLibraryController, 'createTextSnippet', 'posts:draft'],
  [MediaLibraryController, 'getTextSnippets', 'posts:view'],
  [MediaLibraryController, 'bulkTextSnippets', 'posts:draft'],
  [MediaLibraryController, 'getTextSnippet', 'posts:view'],
  [MediaLibraryController, 'updateTextSnippet', 'posts:draft'],
  [MediaLibraryController, 'deleteTextSnippet', 'posts:draft'],
  [MediaLibraryController, 'restoreTextSnippet', 'posts:draft'],
  [MediaLibraryController, 'recordTextSnippetUsage', 'posts:draft'],
  [MediaLibraryController, 'createSavedLink', 'posts:draft'],
  [MediaLibraryController, 'getSavedLinks', 'posts:view'],
  [MediaLibraryController, 'bulkSavedLinks', 'posts:draft'],
  [MediaLibraryController, 'getSavedLink', 'posts:view'],
  [MediaLibraryController, 'updateSavedLink', 'posts:draft'],
  [MediaLibraryController, 'refreshLinkPreview', 'posts:draft'],
  [MediaLibraryController, 'deleteSavedLink', 'posts:draft'],
  [MediaLibraryController, 'restoreSavedLink', 'posts:draft'],
  [MediaLibraryController, 'recordSavedLinkUsage', 'posts:draft'],
  [MediaLibraryController, 'getRecycleBin', 'posts:view'],
  [MediaLibraryController, 'restoreRecycleBinItems', 'posts:draft'],
  // media-sources/media-sources.controller.ts
  [MediaSourcesController, 'browse', 'posts:draft'],
  [MediaSourcesController, 'import', 'posts:draft'],
  // planner/planner-best-times.controller.ts
  [PlannerBestTimesController, 'get', 'posts:view'],
  // planner/planner-notes.controller.ts
  [PlannerNotesController, 'list', 'posts:view'],
  // planner/planner-preferences.controller.ts
  [PlannerPreferencesController, 'get', 'posts:view'],
  [PlannerPreferencesController, 'update', 'posts:view'],
  // planner/planner-queue.controller.ts
  [PlannerQueueController, 'get', 'posts:view'],
  // planner/planner.controller.ts
  [PlannerController, 'list', 'posts:view'],
  [PlannerController, 'monthCounts', 'posts:view'],
  [PlannerController, 'nextPost', 'posts:view'],
  [PlannerController, 'lastPostTime', 'posts:view'],
  // post-comments/post-comments.controller.ts
  [PostCommentsController, 'list', 'posts:view'],
  [PostCommentsController, 'create', 'posts:comment'],
  [PostCommentsController, 'update', 'posts:comment'],
  [PostCommentsController, 'remove', 'posts:comment'],
  // posts/composer/composer.controller.ts
  [ComposerController, 'saveDraft', 'posts:draft'],
  [ComposerController, 'listDrafts', 'posts:view'],
  [ComposerController, 'getDraft', 'posts:view'],
  [ComposerController, 'listVersions', 'posts:view'],
  [ComposerController, 'restoreVersion', 'posts:draft'],
  [ComposerController, 'getApproval', 'posts:view'],
  [ComposerController, 'setApproval', 'posts:draft'],
  [ComposerController, 'deleteDraft', 'posts:draft'],
  [ComposerController, 'listLabels', 'posts:view'],
  [ComposerController, 'linkPreview', 'posts:draft'],
  // posts/posts.controller.ts
  [PostsController, 'createPost', 'posts:draft'],
  [PostsController, 'getWorkspacePosts', 'posts:view'],
  [PostsController, 'getCalendarPosts', 'posts:view'],
  [PostsController, 'listDrafts', 'posts:view'],
  [PostsController, 'getPost', 'posts:view'],
  [PostsController, 'setReady', 'posts:draft'],
  [PostsController, 'duplicatePost', 'posts:draft'],
  [PostsController, 'updatePost', 'posts:draft'],
  [PostsController, 'deletePost', 'posts:draft'],
  [PostsController, 'getPostHistory', 'posts:view'],
  // short-links/short-links.controller.ts
  [ShortLinksController, 'create', 'posts:draft'],
  [ShortLinksController, 'list', 'posts:view'],
  // workspace/workspace.controller.ts
  [WorkspaceController, 'publishingDefaults', 'posts:view'],
];

// READ routes that are not HTTP GETs but still belong to a Viewer, or WRITES
// that touch only the caller's own row. Everything else tagged posts:view must
// be a GET. (Two more such routes, the insights next-steps hide and the
// reports preview, sit behind class-level analytics:view, so they are not in
// this table.)
const NON_GET_VIEW_ROUTES = new Set([
  'MediaLibraryController.createCategoryZipTicket', // signs an HMAC ticket, writes nothing
  'PlannerPreferencesController.update', // the caller's own Planner view settings
]);

const POSTS_CAPS: readonly string[] = [
  'posts:view',
  'posts:draft',
  'posts:comment',
];

function handlerOf(controller: Controller, method: string): object {
  return (controller.prototype as Record<string, object>)[method];
}

function capOf(controller: Controller, method: string): string | undefined {
  return Reflect.getMetadata(
    REQUIRE_CAPABILITY,
    handlerOf(controller, method),
  ) as string | undefined;
}

describe('posts capabilities on every formerly posts:draft route', () => {
  it('covers all 144 routes without duplicates', () => {
    expect(ROWS).toHaveLength(144);
    const keys = ROWS.map(([c, m]) => `${c.name}.${m}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(ROWS.map(([c, m, cap]) => [`${c.name}.${m}`, c, m, cap] as const))(
    '%s demands its capability',
    (_name, controller, method, expected) => {
      expect(capOf(controller, method)).toBe(expected);
    },
  );

  it('no route outside the table still carries a posts capability', () => {
    const inTable = new Set(ROWS.map(([c, m]) => `${c.name}.${m}`));
    const controllers = new Set(ROWS.map(([c]) => c));
    const strays: string[] = [];
    for (const controller of controllers) {
      for (const method of Object.getOwnPropertyNames(controller.prototype)) {
        const cap = capOf(controller, method);
        if (
          cap !== undefined &&
          POSTS_CAPS.includes(cap) &&
          !inTable.has(`${controller.name}.${method}`)
        ) {
          strays.push(`${controller.name}.${method} (${cap})`);
        }
      }
    }
    expect(strays).toEqual([]);
  });

  it('no route still requires a capability that maps to GUEST for a write', () => {
    const offenders = ROWS.filter(([controller, method]) => {
      if (capOf(controller, method) !== 'posts:view') return false;
      const verb = Reflect.getMetadata(
        METHOD_METADATA,
        handlerOf(controller, method),
      ) as RequestMethod | undefined;
      return (
        verb !== RequestMethod.GET &&
        !NON_GET_VIEW_ROUTES.has(`${controller.name}.${method}`)
      );
    }).map(([c, m]) => `${c.name}.${m}`);
    expect(offenders).toEqual([]);
  });

  it('only the post comments routes take posts:comment', () => {
    const commenters = ROWS.filter(([, , cap]) => cap === 'posts:comment').map(
      ([c, m]) => `${c.name}.${m}`,
    );
    expect(commenters.sort()).toEqual([
      'PostCommentsController.create',
      'PostCommentsController.remove',
      'PostCommentsController.update',
    ]);
  });
});
