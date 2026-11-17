import { Global, Module } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from './schema';
import {
  DatabaseLifecycleService,
  MANAGED_POOL,
} from './database-lifecycle.service';
import { pool } from './db';

export const DRIZZLE = 'DRIZZLE';

/** The pool behind DRIZZLE, exposed so health checks and shutdown can reach it. */
export const DRIZZLE_POOL = 'DRIZZLE_POOL';

/**
 * Provides the Drizzle client over the application's single Postgres pool.
 *
 * ## Why this module does not create its own pool
 *
 * It used to. The result was two pools on the same database with the same
 * config: the module-level singleton in `db.ts`, which 196 files import as
 * `db`, and a second one built here for the ~130 files that inject `DRIZZLE`.
 * `max` is per pool, so a `max: 10` process actually held up to 20 connections
 * — and a web/worker split would have doubled that again. Nothing asked for
 * the second pool; it came from the two access styles growing up separately.
 *
 * Reusing the `db.ts` pool collapses that to one without touching either
 * style's 300-odd call sites: `db` keeps working, `DRIZZLE` keeps working, and
 * `max` now means what it says. The pool is created at import time rather than
 * by a factory, which is also why `DATABASE_URL` is validated there.
 *
 * One pool also makes shutdown honest: there is a single thing to drain, so
 * the lifecycle service below is the only closer, instead of two instances
 * racing to end two pools.
 */
@Global()
@Module({
  providers: [
    { provide: DRIZZLE_POOL, useValue: pool },
    {
      provide: DRIZZLE,
      inject: [DRIZZLE_POOL],
      useFactory: (p: Pool) => drizzle(p, { schema }),
    },
    { provide: MANAGED_POOL, useValue: pool },
    DatabaseLifecycleService,
  ],
  exports: [DRIZZLE, DRIZZLE_POOL],
})
export class DrizzleModule {}
