-- Seed the NVIDIA model into "ai_models".
--
-- Data only: no table, column, index, or enum changes. The "ModelProvider" enum
-- already carries NVIDIA and the table already stores a provider per row (see
-- 20260923000000_initial_data_foundation), so adding a model offered by a second
-- provider is one more row, exactly as the catalog comment in
-- src/server/ai/models/catalog.ts describes.
--
-- The row is required, not decorative: `user_preferences.preferredModelId`
-- references `ai_models.id`, so a catalog key with no row here cannot be saved as a
-- preference at all (the write fails the foreign key and the API answers that the
-- model is unavailable). The id is the catalog key, so a stored preference keeps
-- pointing at the same model across migrations.
--
-- As in the first seed, the statement is idempotent and refreshes the descriptive
-- columns on re-apply, so a renamed display name or a deactivated model can be
-- rolled out by a later migration. Adding a row here is not enough by itself: the
-- key must also exist in the code catalog, which is the source of truth the API and
-- the reply flow validate against.

INSERT INTO "ai_models" ("id", "provider", "modelIdentifier", "displayName", "isActive", "createdAt", "updatedAt")
VALUES
  ('nvidia-llama-3.3-70b', 'NVIDIA', 'meta/llama-3.3-70b-instruct', 'Llama 3.3 70B', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO UPDATE SET
  "provider" = EXCLUDED."provider",
  "modelIdentifier" = EXCLUDED."modelIdentifier",
  "displayName" = EXCLUDED."displayName",
  "isActive" = EXCLUDED."isActive",
  "updatedAt" = CURRENT_TIMESTAMP;
