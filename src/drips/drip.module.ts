import { Module, forwardRef } from '@nestjs/common';
import { DripController } from './drip.controller';
import { DripService } from './drip.service';
import { DripProcessor } from './processors/drip.processor';
import { DrizzleModule } from '../drizzle/drizzle.module';
import { QueueModule } from '../queue/queue.module';
import { AiModule } from '../ai/ai.module';
import { PostsModule } from '../posts/posts.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [
    DrizzleModule,
    QueueModule,
    AiModule,
    EmailModule,
    forwardRef(() => PostsModule), // Use forwardRef to avoid circular dependency
  ],
  controllers: [DripController],
  providers: [DripService, DripProcessor],
  exports: [DripService],
})
export class DripModule {}
