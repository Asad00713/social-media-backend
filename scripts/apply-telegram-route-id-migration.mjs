import { neon } from '@neondatabase/serverless';
import 'dotenv/config';

const sql = neon(process.env.DATABASE_URL);

const run = async () => {
  await sql`ALTER TABLE "social_media_channels" ADD COLUMN IF NOT EXISTS "telegram_webhook_route_id" text`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "social_media_channels_telegram_webhook_route_id_unique" ON "social_media_channels" ("telegram_webhook_route_id")`;
  console.log('✓ telegram_webhook_route_id column + unique index applied');
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
