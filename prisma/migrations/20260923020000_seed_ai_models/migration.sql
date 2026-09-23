-- Seed the model catalog into "ai_models".
--
-- The catalog itself is defined in code (src/server/ai/models/catalog.ts) and is what
-- the application reads, validates against, and maps to OpenRouter identifiers. These
-- rows exist for two reasons: `user_preferences.preferredModelId` references them, and
-- a deployment can inspect the offered models with plain SQL. Ids are the catalog keys
-- (stable and readable rather than generated), so a preference row keeps pointing at
-- the same model across migrations.
--
-- The statement is idempotent and updates the descriptive columns on re-apply, so a
-- renamed display name or a deactivated model can be rolled out by a later migration.
-- Adding a model here is not enough by itself: the key must also exist in the catalog,
-- which is the source of truth the API and the reply flow validate against.

INSERT INTO "ai_models" ("id", "provider", "modelIdentifier", "displayName", "isActive", "createdAt", "updatedAt")
VALUES
  ('gpt-4o-mini', 'OPENROUTER', 'openai/gpt-4o-mini', 'GPT-4o mini', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('gpt-4o', 'OPENROUTER', 'openai/gpt-4o', 'GPT-4o', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('claude-3.5-haiku', 'OPENROUTER', 'anthropic/claude-3.5-haiku', 'Claude 3.5 Haiku', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('claude-3.7-sonnet', 'OPENROUTER', 'anthropic/claude-3.7-sonnet', 'Claude 3.7 Sonnet', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('llama-3.1-70b', 'OPENROUTER', 'meta-llama/llama-3.1-70b-instruct', 'Llama 3.1 70B', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO UPDATE SET
  "provider" = EXCLUDED."provider",
  "modelIdentifier" = EXCLUDED."modelIdentifier",
  "displayName" = EXCLUDED."displayName",
  "isActive" = EXCLUDED."isActive",
  "updatedAt" = CURRENT_TIMESTAMP;
