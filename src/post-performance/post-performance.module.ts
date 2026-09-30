import { Module } from '@nestjs/common';
import { PostPerformanceRepository } from './post-performance.repository';

/**
 * How published posts performed, counted one way for every screen that shows
 * it (Home today, Insights next). Needs only the global Drizzle provider.
 */
@Module({
  providers: [PostPerformanceRepository],
  exports: [PostPerformanceRepository],
})
export class PostPerformanceModule {}
