-- Maestro BYOK (bring your own Anthropic key) + first-run wizard flag.
--
-- maestro_anthropic_key      encrypted (AES-256-GCM) Anthropic API key. NULL =
--                            use the platform key and bill plan credits.
-- maestro_anthropic_key_hint last 4 chars, plaintext, so settings can show
--                            "sk-ant-...4f2a" without decrypting the real key.
-- maestro_onboarded_at       NULL = the first-run Maestro wizard is still due.
--
-- Written by hand (not drizzle-kit) to match 0024/0027 and avoid reconciling
-- unrelated journal drift. Idempotent so it is safe to re-run on prod.

ALTER TABLE "workspace" ADD COLUMN IF NOT EXISTS "maestro_anthropic_key" text;
ALTER TABLE "workspace" ADD COLUMN IF NOT EXISTS "maestro_anthropic_key_hint" varchar(8);
ALTER TABLE "workspace" ADD COLUMN IF NOT EXISTS "maestro_anthropic_key_set_at" timestamp;
ALTER TABLE "workspace" ADD COLUMN IF NOT EXISTS "maestro_onboarded_at" timestamp;
