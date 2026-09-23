-- Generated with Prisma migrate diff, then reviewed and augmented with
-- citext and two PostgreSQL CHECK constraints (not expressible in Prisma 6).
-- No application data is inserted. Run the migration as a schema owner.
BEGIN;

-- Case-insensitive email equality and uniqueness. On managed PostgreSQL,
-- an administrator may need to provision this extension before deployment.
CREATE EXTENSION IF NOT EXISTS "citext" WITH SCHEMA "public";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ModelProvider" AS ENUM ('OPENROUTER', 'NVIDIA');

-- CreateEnum
CREATE TYPE "ThemePreference" AS ENUM ('SYSTEM', 'DARK', 'LIGHT');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL DEFAULT 'New conversation',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_models" (
    "id" TEXT NOT NULL,
    "provider" "ModelProvider" NOT NULL,
    "modelIdentifier" VARCHAR(255) NOT NULL,
    "displayName" VARCHAR(160) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "userId" TEXT NOT NULL,
    "preferredModelId" TEXT,
    "theme" "ThemePreference" NOT NULL DEFAULT 'SYSTEM',
    "selectedPetKey" VARCHAR(100),
    "uiPreferences" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "conversations_userId_updatedAt_id_idx" ON "conversations"("userId", "updatedAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversationId_position_key" ON "messages"("conversationId", "position");

-- CreateIndex
CREATE INDEX "ai_models_isActive_provider_displayName_id_idx" ON "ai_models"("isActive", "provider", "displayName", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_models_provider_modelIdentifier_key" ON "ai_models"("provider", "modelIdentifier");

-- CreateIndex
CREATE INDEX "user_preferences_preferredModelId_idx" ON "user_preferences"("preferredModelId");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_preferredModelId_fkey" FOREIGN KEY ("preferredModelId") REFERENCES "ai_models"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Preserve these SQL-only checks in future migrations.
ALTER TABLE "messages" ADD CONSTRAINT "messages_position_nonnegative"
  CHECK ("position" >= 0);

ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_ui_object"
  CHECK (jsonb_typeof("uiPreferences") = 'object');

COMMIT;
