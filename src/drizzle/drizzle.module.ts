import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { buildPoolConfig } from './pool-config';
import {
  DatabaseLifecycleService,
  MANAGED_POOL,
} from './database-lifecycle.service';
import { pool as standalonePool } from './db';

export const DRIZZLE = 'DRIZZLE';

/** The pool behind DRIZZLE, exposed so it can be closed on shutdown. */
export const DRIZZLE_POOL = 'DRIZZLE_POOL';

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE_POOL,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const databaseUrl = configService.get<string>('DATABASE_URL');

        if (!databaseUrl) {
          throw new Error('DATABASE_URL is not defined');
        }

        const pool = new Pool(buildPoolConfig(databaseUrl));
        pool.on('error', (err) => {
          console.error('[DrizzleModule] unexpected idle client error', err);
        });
        return pool;
      },
    },
    {
      provide: DRIZZLE,
      inject: [DRIZZLE_POOL],
      useFactory: (pool: Pool) => drizzle(pool, { schema }),
    },
    // Two pools exist and both must drain. This one backs DRIZZLE; the other
    // is the module-level singleton in db.ts, which the migration scripts and
    // anything importing `db` directly use.
    {
      provide: DatabaseLifecycleService,
      inject: [DRIZZLE_POOL],
      useFactory: (pool: Pool) => new DatabaseLifecycleService(pool),
    },
    {
      provide: 'STANDALONE_POOL_LIFECYCLE',
      useFactory: () => new DatabaseLifecycleService(standalonePool),
    },
  ],
  exports: [DRIZZLE],
})
export class DrizzleModule {}
