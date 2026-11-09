-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('YOUTUBE', 'INSTAGRAM');

-- CreateEnum
CREATE TYPE "ConnectedAccountStatus" AS ENUM ('PENDING', 'CONNECTED', 'EXPIRED', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "TokenHealth" AS ENUM ('UNKNOWN', 'VALID', 'EXPIRING_SOON', 'EXPIRED', 'INVALID');

-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('UPLOAD', 'DIRECT_URL', 'STORAGE_PROVIDER');

-- CreateEnum
CREATE TYPE "SourceStatus" AS ENUM ('INITIATED', 'UPLOADED', 'VALIDATED', 'REJECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MediaAssetKind" AS ENUM ('SOURCE_VIDEO', 'EXTRACTED_AUDIO', 'FRAME', 'RENDERED_CLIP', 'THUMBNAIL', 'SUBTITLE', 'OTHER');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('CREATED', 'UPLOADING', 'QUEUED', 'PROBING', 'TRANSCRIBING', 'AI_ANALYSIS', 'CLIP_SELECTION', 'RENDERING', 'VALIDATION', 'ASSET_STORAGE', 'PUBLISHING_QUEUED', 'PUBLISHING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED', 'NEEDS_CONFIGURATION', 'RETRYING');

-- CreateEnum
CREATE TYPE "JobStageStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CandidateStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'REJECTED', 'RENDERED', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "ClipStatus" AS ENUM ('PLANNED', 'RENDERING', 'RENDER_FAILED', 'READY', 'PUBLISHING', 'PUBLISHED', 'PARTIALLY_PUBLISHED', 'PUBLISH_FAILED');

-- CreateEnum
CREATE TYPE "PublishingStatus" AS ENUM ('PENDING', 'ELIGIBILITY_CHECK', 'QUEUED', 'UPLOADING', 'AWAITING_PLATFORM', 'PUBLISHED', 'FAILED', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PublishingOperation" AS ENUM ('SINGLE_VIDEO_UPLOAD', 'REEL_PUBLISH', 'CONTAINER_STATUS_CHECK', 'NONE');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('AUTH_LOGIN', 'AUTH_LOGOUT', 'AUTH_BOOTSTRAP', 'USER_CREATED', 'ACCOUNT_CONNECTED', 'ACCOUNT_DISCONNECTED', 'ACCOUNT_TOKEN_REFRESHED', 'SOURCE_UPLOADED', 'JOB_CREATED', 'JOB_CANCELLED', 'JOB_RETRIED', 'JOB_STAGE_CHANGED', 'CLIP_RENDERED', 'CLIP_METADATA_EDITED', 'PUBLISHING_ENABLED', 'PUBLISHING_DISABLED', 'PUBLISH_ATTEMPTED', 'PUBLISH_SUCCEEDED', 'PUBLISH_FAILED', 'CONFIG_CHANGED', 'RIGHTS_DECLARED');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('PUBLIC', 'UNLISTED', 'PRIVATE');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "HealthSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'OWNER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectedAccount" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "username" TEXT,
    "avatarUrl" TEXT,
    "status" "ConnectedAccountStatus" NOT NULL DEFAULT 'PENDING',
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenHealth" "TokenHealth" NOT NULL DEFAULT 'UNKNOWN',
    "tokenCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "publishingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "publishingConfig" JSONB,
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectedAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthCredential" (
    "id" UUID NOT NULL,
    "connectedAccountId" UUID NOT NULL,
    "accessTokenEnc" JSONB NOT NULL,
    "refreshTokenEnc" JSONB,
    "tokenType" TEXT NOT NULL DEFAULT 'Bearer',
    "scope" TEXT,
    "expiresAt" TIMESTAMP(3),
    "refreshedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceVideo" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "kind" "SourceKind" NOT NULL,
    "status" "SourceStatus" NOT NULL DEFAULT 'INITIATED',
    "originalFileName" TEXT,
    "declaredMimeType" TEXT,
    "detectedMimeType" TEXT,
    "sizeBytes" BIGINT,
    "storageKey" TEXT,
    "sourceUrl" TEXT,
    "youTubeReferenceId" TEXT,
    "youTubeReferenceUrl" TEXT,
    "rightsDeclaration" JSONB,
    "probeResult" JSONB,
    "durationSeconds" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "frameRate" DOUBLE PRECISION,
    "validationReport" JSONB,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SourceVideo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "sourceVideoId" UUID,
    "kind" "MediaAssetKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "checksumSha256" TEXT,
    "durationSeconds" DOUBLE PRECISION,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageObject" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "driver" TEXT NOT NULL,
    "bucket" TEXT,
    "key" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "contentType" TEXT,
    "checksum" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorageObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingJob" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "sourceVideoId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'CREATED',
    "stage" "JobStatus" NOT NULL DEFAULT 'CREATED',
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "progressDetail" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "workerId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "configuration" JSONB NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "errorDetails" JSONB,
    "resultSummary" JSONB,
    "estimatedCompletionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ProcessingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobStage" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "stage" "JobStatus" NOT NULL,
    "status" "JobStageStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "input" JSONB,
    "output" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "workerId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transcript" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "sourceVideoId" UUID NOT NULL,
    "jobId" UUID,
    "language" TEXT NOT NULL,
    "languageProbability" DOUBLE PRECISION NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "wordTimestamps" BOOLEAN NOT NULL DEFAULT true,
    "durationSeconds" DOUBLE PRECISION,
    "fullText" TEXT NOT NULL,
    "storageKey" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transcript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranscriptSegment" (
    "id" UUID NOT NULL,
    "transcriptId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "startSeconds" DOUBLE PRECISION NOT NULL,
    "endSeconds" DOUBLE PRECISION NOT NULL,
    "text" TEXT NOT NULL,
    "speakerLabel" TEXT,
    "avgLogprob" DOUBLE PRECISION,
    "noSpeechProb" DOUBLE PRECISION,
    "words" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranscriptSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HighlightCandidate" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "transcriptId" UUID,
    "startSeconds" DOUBLE PRECISION NOT NULL,
    "endSeconds" DOUBLE PRECISION NOT NULL,
    "targetDuration" INTEGER NOT NULL,
    "hook" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "transcriptText" TEXT NOT NULL,
    "contentCategory" TEXT NOT NULL,
    "qualityScore" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "visualContext" TEXT,
    "scores" JSONB NOT NULL,
    "status" "CandidateStatus" NOT NULL DEFAULT 'PROPOSED',
    "rejectionReason" TEXT,
    "modelMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HighlightCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeneratedClip" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "candidateId" UUID,
    "title" TEXT NOT NULL,
    "contentCategory" TEXT NOT NULL,
    "qualityScore" INTEGER NOT NULL,
    "status" "ClipStatus" NOT NULL DEFAULT 'PLANNED',
    "startSeconds" DOUBLE PRECISION NOT NULL,
    "endSeconds" DOUBLE PRECISION NOT NULL,
    "durationKind" INTEGER NOT NULL,
    "duplicateOfClipId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeneratedClip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClipVariant" (
    "id" UUID NOT NULL,
    "clipId" UUID NOT NULL,
    "mediaAssetId" UUID,
    "subtitleAssetId" UUID,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "fps" INTEGER NOT NULL,
    "videoCodec" TEXT NOT NULL,
    "audioCodec" TEXT NOT NULL,
    "bitrateKbps" INTEGER,
    "container" TEXT NOT NULL DEFAULT 'mp4',
    "sizeBytes" BIGINT,
    "durationSeconds" DOUBLE PRECISION,
    "renderProfile" JSONB NOT NULL,
    "renderReport" JSONB,
    "checksumSha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClipVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClipMetadata" (
    "id" UUID NOT NULL,
    "clipId" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "language" TEXT NOT NULL,
    "brandVoice" TEXT,
    "model" TEXT NOT NULL,
    "reviewStatus" TEXT NOT NULL DEFAULT 'DRAFT',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClipMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishingJob" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "clipId" UUID NOT NULL,
    "clipVariantId" UUID,
    "connectedAccountId" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "operation" "PublishingOperation" NOT NULL DEFAULT 'NONE',
    "status" "PublishingStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3),
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "visibility" "Visibility",
    "platformMetadata" JSONB,
    "externalId" TEXT,
    "externalUrl" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "retryable" BOOLEAN,
    "workerId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PublishingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishingAttempt" (
    "id" UUID NOT NULL,
    "publishingJobId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "operation" "PublishingOperation" NOT NULL,
    "requestSummary" JSONB NOT NULL,
    "httpStatus" INTEGER,
    "responseSummary" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "retryable" BOOLEAN,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "workerId" TEXT,

    CONSTRAINT "PublishingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishedPost" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "publishingJobId" UUID,
    "connectedAccountId" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalUrl" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "visibility" "Visibility",
    "platformResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublishedPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandProfile" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "primaryColor" TEXT,
    "secondaryColor" TEXT,
    "textColor" TEXT,
    "logoStorageKey" TEXT,
    "fontFamily" TEXT,
    "brandVoice" TEXT,
    "customVoiceInstructions" TEXT,
    "audienceDescription" TEXT,
    "introEnabled" BOOLEAN NOT NULL DEFAULT false,
    "outroEnabled" BOOLEAN NOT NULL DEFAULT false,
    "introAssetKey" TEXT,
    "outroAssetKey" TEXT,
    "watermarkPosition" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeneratedClipMetadataLink" (
    "id" UUID NOT NULL,
    "clipId" UUID NOT NULL,
    "brandProfileId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeneratedClipMetadataLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubtitlePreset" (
    "id" UUID NOT NULL,
    "workspaceId" UUID,
    "name" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "style" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubtitlePreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationConfiguration" (
    "id" UUID NOT NULL,
    "workspaceId" UUID,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageRecord" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "jobId" UUID,
    "kind" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "costUsd" DOUBLE PRECISION,
    "metadata" JSONB,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "workspaceId" UUID,
    "userId" UUID,
    "action" "AuditAction" NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "summary" TEXT NOT NULL,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID,
    "platform" "Platform",
    "eventType" TEXT NOT NULL,
    "externalId" TEXT,
    "payload" JSONB NOT NULL,
    "signature" TEXT,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemHealthEvent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID,
    "component" TEXT NOT NULL,
    "severity" "HealthSeverity" NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "details" JSONB,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemHealthEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_userId_key" ON "WorkspaceMember"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "ConnectedAccount_workspaceId_platform_idx" ON "ConnectedAccount"("workspaceId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectedAccount_workspaceId_platform_externalAccountId_key" ON "ConnectedAccount"("workspaceId", "platform", "externalAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthCredential_connectedAccountId_key" ON "OAuthCredential"("connectedAccountId");

-- CreateIndex
CREATE INDEX "SourceVideo_workspaceId_status_idx" ON "SourceVideo"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "MediaAsset_workspaceId_kind_idx" ON "MediaAsset"("workspaceId", "kind");

-- CreateIndex
CREATE INDEX "MediaAsset_sourceVideoId_idx" ON "MediaAsset"("sourceVideoId");

-- CreateIndex
CREATE INDEX "StorageObject_workspaceId_idx" ON "StorageObject"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "StorageObject_driver_bucket_key_key" ON "StorageObject"("driver", "bucket", "key");

-- CreateIndex
CREATE INDEX "ProcessingJob_workspaceId_status_idx" ON "ProcessingJob"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "ProcessingJob_status_leaseExpiresAt_idx" ON "ProcessingJob"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "ProcessingJob_sourceVideoId_idx" ON "ProcessingJob"("sourceVideoId");

-- CreateIndex
CREATE INDEX "JobStage_jobId_createdAt_idx" ON "JobStage"("jobId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobStage_jobId_stage_key" ON "JobStage"("jobId", "stage");

-- CreateIndex
CREATE INDEX "Transcript_workspaceId_sourceVideoId_idx" ON "Transcript"("workspaceId", "sourceVideoId");

-- CreateIndex
CREATE INDEX "TranscriptSegment_transcriptId_startSeconds_idx" ON "TranscriptSegment"("transcriptId", "startSeconds");

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptSegment_transcriptId_sequence_key" ON "TranscriptSegment"("transcriptId", "sequence");

-- CreateIndex
CREATE INDEX "HighlightCandidate_workspaceId_jobId_idx" ON "HighlightCandidate"("workspaceId", "jobId");

-- CreateIndex
CREATE INDEX "HighlightCandidate_jobId_status_idx" ON "HighlightCandidate"("jobId", "status");

-- CreateIndex
CREATE INDEX "GeneratedClip_workspaceId_status_idx" ON "GeneratedClip"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "GeneratedClip_jobId_durationKind_idx" ON "GeneratedClip"("jobId", "durationKind");

-- CreateIndex
CREATE INDEX "ClipVariant_clipId_idx" ON "ClipVariant"("clipId");

-- CreateIndex
CREATE UNIQUE INDEX "ClipMetadata_clipId_platform_key" ON "ClipMetadata"("clipId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "PublishingJob_idempotencyKey_key" ON "PublishingJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PublishingJob_workspaceId_status_idx" ON "PublishingJob"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "PublishingJob_status_nextAttemptAt_idx" ON "PublishingJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "PublishingJob_clipId_platform_idx" ON "PublishingJob"("clipId", "platform");

-- CreateIndex
CREATE INDEX "PublishingAttempt_publishingJobId_idx" ON "PublishingAttempt"("publishingJobId");

-- CreateIndex
CREATE UNIQUE INDEX "PublishingAttempt_publishingJobId_attemptNumber_operation_key" ON "PublishingAttempt"("publishingJobId", "attemptNumber", "operation");

-- CreateIndex
CREATE INDEX "PublishedPost_workspaceId_platform_idx" ON "PublishedPost"("workspaceId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "PublishedPost_platform_connectedAccountId_externalId_key" ON "PublishedPost"("platform", "connectedAccountId", "externalId");

-- CreateIndex
CREATE INDEX "BrandProfile_workspaceId_idx" ON "BrandProfile"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedClipMetadataLink_clipId_brandProfileId_key" ON "GeneratedClipMetadataLink"("clipId", "brandProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "SubtitlePreset_workspaceId_name_key" ON "SubtitlePreset"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "ApplicationConfiguration_key_idx" ON "ApplicationConfiguration"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationConfiguration_workspaceId_key_key" ON "ApplicationConfiguration"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "UsageRecord_workspaceId_kind_recordedAt_idx" ON "UsageRecord"("workspaceId", "kind", "recordedAt");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_createdAt_idx" ON "AuditLog"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_receivedAt_idx" ON "WebhookEvent"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_platform_externalId_eventType_key" ON "WebhookEvent"("platform", "externalId", "eventType");

-- CreateIndex
CREATE INDEX "SystemHealthEvent_component_observedAt_idx" ON "SystemHealthEvent"("component", "observedAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_availableAt_idx" ON "OutboxEvent"("publishedAt", "availableAt");

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectedAccount" ADD CONSTRAINT "ConnectedAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthCredential" ADD CONSTRAINT "OAuthCredential_connectedAccountId_fkey" FOREIGN KEY ("connectedAccountId") REFERENCES "ConnectedAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceVideo" ADD CONSTRAINT "SourceVideo_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_sourceVideoId_fkey" FOREIGN KEY ("sourceVideoId") REFERENCES "SourceVideo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageObject" ADD CONSTRAINT "StorageObject_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_sourceVideoId_fkey" FOREIGN KEY ("sourceVideoId") REFERENCES "SourceVideo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobStage" ADD CONSTRAINT "JobStage_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProcessingJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transcript" ADD CONSTRAINT "Transcript_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transcript" ADD CONSTRAINT "Transcript_sourceVideoId_fkey" FOREIGN KEY ("sourceVideoId") REFERENCES "SourceVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transcript" ADD CONSTRAINT "Transcript_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProcessingJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptSegment" ADD CONSTRAINT "TranscriptSegment_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "Transcript"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HighlightCandidate" ADD CONSTRAINT "HighlightCandidate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HighlightCandidate" ADD CONSTRAINT "HighlightCandidate_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProcessingJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedClip" ADD CONSTRAINT "GeneratedClip_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedClip" ADD CONSTRAINT "GeneratedClip_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProcessingJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedClip" ADD CONSTRAINT "GeneratedClip_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "HighlightCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipVariant" ADD CONSTRAINT "ClipVariant_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "GeneratedClip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipVariant" ADD CONSTRAINT "ClipVariant_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipMetadata" ADD CONSTRAINT "ClipMetadata_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "GeneratedClip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingJob" ADD CONSTRAINT "PublishingJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingJob" ADD CONSTRAINT "PublishingJob_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "GeneratedClip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingJob" ADD CONSTRAINT "PublishingJob_clipVariantId_fkey" FOREIGN KEY ("clipVariantId") REFERENCES "ClipVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingJob" ADD CONSTRAINT "PublishingJob_connectedAccountId_fkey" FOREIGN KEY ("connectedAccountId") REFERENCES "ConnectedAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingAttempt" ADD CONSTRAINT "PublishingAttempt_publishingJobId_fkey" FOREIGN KEY ("publishingJobId") REFERENCES "PublishingJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishedPost" ADD CONSTRAINT "PublishedPost_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishedPost" ADD CONSTRAINT "PublishedPost_connectedAccountId_fkey" FOREIGN KEY ("connectedAccountId") REFERENCES "ConnectedAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandProfile" ADD CONSTRAINT "BrandProfile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedClipMetadataLink" ADD CONSTRAINT "GeneratedClipMetadataLink_brandProfileId_fkey" FOREIGN KEY ("brandProfileId") REFERENCES "BrandProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubtitlePreset" ADD CONSTRAINT "SubtitlePreset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationConfiguration" ADD CONSTRAINT "ApplicationConfiguration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProcessingJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemHealthEvent" ADD CONSTRAINT "SystemHealthEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
