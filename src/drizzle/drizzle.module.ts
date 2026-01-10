import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import * as schema from './schema';

export const DRIZZLE = 'DRIZZLE';

@Global()
@Module({
    providers: [
        {
            provide: DRIZZLE,
            inject: [ConfigService],
            useFactory: async (configService: ConfigService) => {
                const databaseUrl = configService.get<string>('DATABASE_URL');

                if (!databaseUrl) {
                    throw new Error('DATABASE_URL is not defined');
                }

                const sql = neon(databaseUrl);
                return drizzle(sql, { schema });
            },
        },
    ],
    exports: [DRIZZLE],
})
export class DrizzleModule { }