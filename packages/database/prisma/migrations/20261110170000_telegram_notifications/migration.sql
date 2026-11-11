-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('WORKFLOW_STARTED', 'SOURCE_DETECTED', 'SOURCE_DOWNLOADED', 'AI_STARTED', 'AI_COMPLETED', 'METADATA_COMPLETED', 'UPLOAD_STARTED', 'PUBLISH_COMPLETED', 'WORKFLOW_FAILED', 'AUTH_EXPIRED', 'QUOTA_ERROR', 'SCHEDULED_STARTED', 'SCHEDULE_MISSED', 'WORKFLOW_STOPPED', 'DAILY_SUMMARY', 'CONNECTION_TEST');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'NOTIFICATION_SETTINGS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'NOTIFICATION_SENT';
ALTER TYPE "AuditAction" ADD VALUE 'NOTIFICATION_FAILED';

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "dedupeKey" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "jobId" UUID,
    "clipId" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "telegramMessageId" INTEGER,
    "chatIdSuffix" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationDelivery_workspaceId_createdAt_idx" ON "NotificationDelivery"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_status_nextAttemptAt_idx" ON "NotificationDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_workspaceId_dedupeKey_key" ON "NotificationDelivery"("workspaceId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

