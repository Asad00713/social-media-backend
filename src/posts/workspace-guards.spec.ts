/* eslint-disable @typescript-eslint/no-unsafe-argument -- Reflect metadata reads */
import 'reflect-metadata';
import { REQUIRE_CAPABILITY } from '../workspace-members/require-capability.decorator';
import { WorkspaceRoleGuard } from '../workspace-members/workspace-role.guard';
import { PostsController } from './posts.controller';
import { ComposerController } from './composer/composer.controller';
import { CampaignsController } from '../campaigns/campaigns.controller';
import { EvergreenController } from '../campaigns/evergreen.controller';
import { DripController } from '../drips/drip.controller';

type Cap = 'posts:draft' | 'posts:publish';

// Every workspace route and the capability it must demand. A route missing from
// this table, or carrying a different capability, fails the spec.
const EXPECTED: Array<[string, new (...a: any[]) => object, Record<string, Cap | null>]> = [
  [
    'PostsController',
    PostsController,
    {
      createPost: 'posts:draft',
      getWorkspacePosts: 'posts:draft',
      getCalendarPosts: 'posts:draft',
      listDrafts: 'posts:draft',
      getPost: 'posts:draft',
      updatePost: 'posts:draft',
      deletePost: 'posts:draft',
      publishPost: 'posts:publish',
      getPostHistory: 'posts:draft',
      getQueueStatus: null,
      getRateLimitStatus: null,
      getPlatformRateLimitStatus: null,
    },
  ],
  [
    'ComposerController',
    ComposerController,
    {
      saveDraft: 'posts:draft',
      listDrafts: 'posts:draft',
      getDraft: 'posts:draft',
      deleteDraft: 'posts:draft',
      schedule: 'posts:publish',
      cancelSchedule: 'posts:publish',
      publish: 'posts:publish',
    },
  ],
  [
    'CampaignsController',
    CampaignsController,
    {
      statusCounts: 'posts:draft',
      list: 'posts:draft',
      getOne: 'posts:draft',
      createSimple: 'posts:publish',
      createDrip: 'posts:publish',
      update: 'posts:publish',
      remove: 'posts:publish',
      launch: 'posts:publish',
      pause: 'posts:publish',
      resume: 'posts:publish',
      duplicate: 'posts:publish',
      addDay: 'posts:publish',
      removeDay: 'posts:publish',
      setDaySkip: 'posts:publish',
      addEvent: 'posts:publish',
      updateEvent: 'posts:publish',
      removeEvent: 'posts:publish',
      generateAi: 'posts:publish',
      approveAi: 'posts:publish',
      skipAi: 'posts:publish',
    },
  ],
  [
    'EvergreenController',
    EvergreenController,
    {
      createCampaign: 'posts:publish',
      addCategory: 'posts:publish',
      updateCategory: 'posts:publish',
      setCategoryActive: 'posts:publish',
      removeCategory: 'posts:publish',
      addPost: 'posts:publish',
      updatePost: 'posts:publish',
      removePost: 'posts:publish',
      generateVariations: 'posts:publish',
      addVariation: 'posts:publish',
      removeVariation: 'posts:publish',
      checkFreshness: 'posts:publish',
    },
  ],
  [
    'DripController',
    DripController,
    {
      createDripCampaign: 'posts:publish',
      getWorkspaceDripCampaigns: 'posts:draft',
      getWorkspaceScheduledDripPosts: 'posts:draft',
      getDripCampaign: 'posts:draft',
      updateDripCampaign: 'posts:publish',
      deleteDripCampaign: 'posts:publish',
      activateDripCampaign: 'posts:publish',
      pauseDripCampaign: 'posts:publish',
      cancelDripCampaign: 'posts:publish',
      getDripPosts: 'posts:draft',
      getDripPost: 'posts:draft',
      updateDripPostContent: 'posts:publish',
      approveDripPost: 'posts:publish',
      skipDripPost: 'posts:publish',
      getCampaignHistory: 'posts:draft',
      getCampaignStats: 'posts:draft',
    },
  ],
];

describe.each(EXPECTED)('%s workspace guard', (_name, Ctrl, expected) => {
  it('runs WorkspaceRoleGuard at class level', () => {
    const guards: unknown[] = Reflect.getMetadata('__guards__', Ctrl) ?? [];
    expect(guards).toContain(WorkspaceRoleGuard);
  });

  it('covers every route handler, none missing from the table', () => {
    const handlers = Object.getOwnPropertyNames(Ctrl.prototype).filter(
      (n) =>
        n !== 'constructor' &&
        Reflect.getMetadata('path', Ctrl.prototype[n as keyof object]) !== undefined,
    );
    expect(handlers.sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))('%s requires %s', (handler, cap) => {
    const fn = Ctrl.prototype[handler as keyof object];
    const actual = Reflect.getMetadata(REQUIRE_CAPABILITY, fn) as Cap | undefined;
    expect(actual ?? null).toBe(cap);
  });
});
