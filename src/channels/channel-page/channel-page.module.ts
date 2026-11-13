import { Module } from '@nestjs/common';
import { DrizzleModule } from '../../drizzle/drizzle.module';
import { InboxModule } from '../../inbox/inbox.module';
import { InsightsModule } from '../../insights/insights.module';
import { PlannerModule } from '../../planner/planner.module';
import { PostsModule } from '../../posts/posts.module';
import { WorkspaceRoleModule } from '../../workspace-members/workspace-role.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { ChannelPageController } from './channel-page.controller';
import { ChannelPageService } from './services/channel-page.service';
import { ChannelPostsService } from './services/channel-posts.service';

// Its own module: the page composes Insights (KPIs, tip, best posts), the
// Planner (best times, post presentation), the Inbox (needs reply) and the
// analytics Redis client (refresh limit). ChannelsModule cannot import those
// without a cycle (PostsModule imports ChannelsModule).
// WorkspaceRoleModule (not WorkspaceMembersModule) supplies the guard's
// dependencies without pulling in Billing.
@Module({
  imports: [
    DrizzleModule,
    WorkspaceRoleModule,
    PostsModule,
    PlannerModule,
    InsightsModule,
    InboxModule,
    AnalyticsModule,
  ],
  controllers: [ChannelPageController],
  providers: [ChannelPageService, ChannelPostsService],
})
export class ChannelPageModule {}
