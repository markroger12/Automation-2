-- CreateTable
CREATE TABLE "BrowserProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "profileDir" TEXT NOT NULL,
    "sessionState" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "lastCheckedAt" DATETIME,
    "lastLoginAt" DATETIME,
    "diagnostics" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Website" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "publicUrl" TEXT NOT NULL,
    "adminUrl" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "wordpressProfileId" TEXT,
    "defaultCategoryId" TEXT,
    "editorType" TEXT NOT NULL DEFAULT 'AUTO',
    "detectedEditor" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "targetCountry" TEXT NOT NULL DEFAULT 'United States',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "internalLinkLine" TEXT NOT NULL DEFAULT 'Also read:',
    "logoPath" TEXT,
    "imageSettings" TEXT NOT NULL DEFAULT '{}',
    "imageTemplate" TEXT NOT NULL DEFAULT '{}',
    "canPublish" BOOLEAN NOT NULL DEFAULT false,
    "canPublishAcknowledgedAt" DATETIME,
    "allowLiveUpdates" BOOLEAN NOT NULL DEFAULT false,
    "searchConsoleProperty" TEXT,
    "settingsOverrides" TEXT NOT NULL DEFAULT '{}',
    "promptOverrides" TEXT NOT NULL DEFAULT '{}',
    "linkStrategy" TEXT NOT NULL DEFAULT '{}',
    "queueQuota" INTEGER NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "rankMathTarget" INTEGER,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Website_wordpressProfileId_fkey" FOREIGN KEY ("wordpressProfileId") REFERENCES "BrowserProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "websiteId" TEXT NOT NULL,
    "externalId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "parentExternalId" INTEGER,
    "postCount" INTEGER,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Category_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ArticleTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "moduleKey" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "categoryId" TEXT,
    "categoryName" TEXT,
    "categoryExternalId" INTEGER,
    "keyword" TEXT NOT NULL,
    "normalizedKeyword" TEXT NOT NULL,
    "exampleTitle" TEXT,
    "secondaryKeywords" TEXT NOT NULL DEFAULT '[]',
    "targetCountry" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "stage" TEXT,
    "percent" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "errors" TEXT NOT NULL DEFAULT '[]',
    "reviewReasons" TEXT NOT NULL DEFAULT '[]',
    "nextAction" TEXT,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "options" TEXT NOT NULL DEFAULT '{}',
    "configSnapshot" TEXT NOT NULL DEFAULT '{}',
    "titleOptions" TEXT NOT NULL DEFAULT '[]',
    "recommendedTitle" TEXT,
    "selectedTitle" TEXT,
    "titleApprovedAt" DATETIME,
    "articleApprovedAt" DATETIME,
    "researchNotes" TEXT,
    "outputs" TEXT NOT NULL DEFAULT '{}',
    "bodyHtml" TEXT,
    "editedHtml" TEXT,
    "editedAt" DATETIME,
    "assembledHtml" TEXT,
    "faqs" TEXT NOT NULL DEFAULT '[]',
    "quickBio" TEXT NOT NULL DEFAULT '[]',
    "quickBioHtml" TEXT,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "seoTitle" TEXT,
    "metaDescription" TEXT,
    "slug" TEXT,
    "focusKeyword" TEXT,
    "metrics" TEXT NOT NULL DEFAULT '{}',
    "seoScore" INTEGER,
    "rankMathScore" INTEGER,
    "rankMathVerifiedAt" DATETIME,
    "conversationUrl" TEXT,
    "wpPostId" INTEGER,
    "wpEditUrl" TEXT,
    "wpPostStatus" TEXT,
    "wpDraftAt" DATETIME,
    "wpModifiedGmt" TEXT,
    "wpCreateMarker" TEXT,
    "verifiedCompleteAt" DATETIME,
    "idempotencyKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'SINGLE',
    "campaignId" TEXT,
    "campaignRowId" TEXT,
    "workflowKeywordId" TEXT,
    "benchmarkRunId" TEXT,
    "routeDecision" TEXT NOT NULL DEFAULT '{}',
    "legacy" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "ArticleTask_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ArticleStage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "inputSnapshot" TEXT,
    "promptVersion" TEXT,
    "prompt" TEXT,
    "output" TEXT,
    "outputHtml" TEXT,
    "outputJson" TEXT,
    "error" TEXT,
    "message" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "durationMs" INTEGER,
    "privateState" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ArticleStage_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ArticleTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ArticleStageRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stageId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "prompt" TEXT,
    "output" TEXT,
    "outputHtml" TEXT,
    "outputJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArticleStageRevision_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "ArticleStage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChatGPTResponse" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "jobId" TEXT,
    "operationId" TEXT NOT NULL,
    "promptHash" TEXT NOT NULL,
    "renderedPrompt" TEXT NOT NULL,
    "resultText" TEXT,
    "resultHtml" TEXT,
    "conversationUrl" TEXT,
    "responseFingerprint" TEXT,
    "recovered" BOOLEAN NOT NULL DEFAULT false,
    "reused" BOOLEAN NOT NULL DEFAULT false,
    "conversationSwitch" BOOLEAN NOT NULL DEFAULT false,
    "elapsedMs" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "ChatGPTResponse_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ArticleTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PromptTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "moduleKey" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "defaultHash" TEXT NOT NULL,
    "defaultVersion" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "variables" TEXT NOT NULL DEFAULT '[]',
    "customized" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PromptTemplateVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PromptTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PromptTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QueueJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "queue" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "taskId" TEXT,
    "relatedId" TEXT,
    "websiteId" TEXT,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "result" TEXT,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" DATETIME,
    "lockedBy" TEXT,
    "heartbeatAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "retryPlan" TEXT NOT NULL DEFAULT '{}',
    "idempotencyKey" TEXT NOT NULL,
    "error" TEXT,
    "errorCode" TEXT,
    "claimedByTab" TEXT,
    "conversationUrl" TEXT,
    "progress" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "WorkerStatus" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "version" TEXT,
    "capabilities" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL,
    "diagnostics" TEXT NOT NULL DEFAULT '{}',
    "pid" INTEGER,
    "startedAt" DATETIME,
    "lastSeenAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "level" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "stage" TEXT,
    "taskId" TEXT,
    "jobId" TEXT,
    "message" TEXT NOT NULL,
    "details" TEXT,
    "screenshotPath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SEOReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "score" INTEGER,
    "checks" TEXT NOT NULL DEFAULT '[]',
    "metrics" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SEOReport_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ArticleTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "details" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "websiteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "writerPreference" TEXT NOT NULL DEFAULT 'AUTO',
    "weekdays" TEXT NOT NULL DEFAULT '[]',
    "slots" TEXT NOT NULL DEFAULT '[]',
    "slotTimezone" TEXT NOT NULL DEFAULT 'Asia/Karachi',
    "writeAheadHours" INTEGER NOT NULL DEFAULT 24,
    "maxBacklog" INTEGER NOT NULL DEFAULT 10,
    "imagesOverride" TEXT NOT NULL DEFAULT 'inherit',
    "requestIndexing" BOOLEAN NOT NULL DEFAULT false,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Workflow_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkflowKeyword" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workflowId" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "normalizedKeyword" TEXT NOT NULL,
    "exampleTitle" TEXT,
    "secondaryKeywords" TEXT NOT NULL DEFAULT '[]',
    "writerType" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "detectionReason" TEXT,
    "detectionSource" TEXT,
    "detectionConfidence" REAL,
    "position" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "taskId" TEXT,
    "scheduledAt" DATETIME,
    "publishedUrl" TEXT,
    "publishedAt" DATETIME,
    "indexingRequestedAt" DATETIME,
    "indexingStatus" TEXT,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkflowKeyword_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SlotReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "websiteId" TEXT NOT NULL,
    "scheduledAt" DATETIME NOT NULL,
    "workflowKeywordId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT,
    "websiteId" TEXT,
    "role" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "filePath" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "phash" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "bytes" INTEGER,
    "mime" TEXT,
    "altText" TEXT,
    "wpMediaId" INTEGER,
    "wpUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MediaAsset_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ArticleTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MediaAsset_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DataMigration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" TEXT NOT NULL DEFAULT '{}'
);

-- CreateIndex
CREATE UNIQUE INDEX "BrowserProfile_profileDir_key" ON "BrowserProfile"("profileDir");

-- CreateIndex
CREATE UNIQUE INDEX "Website_slug_key" ON "Website"("slug");

-- CreateIndex
CREATE INDEX "Category_websiteId_name_idx" ON "Category"("websiteId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Category_websiteId_externalId_key" ON "Category"("websiteId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleTask_idempotencyKey_key" ON "ArticleTask"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ArticleTask_status_idx" ON "ArticleTask"("status");

-- CreateIndex
CREATE INDEX "ArticleTask_websiteId_status_idx" ON "ArticleTask"("websiteId", "status");

-- CreateIndex
CREATE INDEX "ArticleTask_createdAt_idx" ON "ArticleTask"("createdAt");

-- CreateIndex
CREATE INDEX "ArticleTask_normalizedKeyword_idx" ON "ArticleTask"("normalizedKeyword");

-- CreateIndex
CREATE INDEX "ArticleTask_moduleKey_idx" ON "ArticleTask"("moduleKey");

-- CreateIndex
CREATE INDEX "ArticleTask_verifiedCompleteAt_idx" ON "ArticleTask"("verifiedCompleteAt");

-- CreateIndex
CREATE INDEX "ArticleStage_status_idx" ON "ArticleStage"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleStage_taskId_key_key" ON "ArticleStage"("taskId", "key");

-- CreateIndex
CREATE INDEX "ArticleStageRevision_taskId_key_idx" ON "ArticleStageRevision"("taskId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ChatGPTResponse_operationId_key" ON "ChatGPTResponse"("operationId");

-- CreateIndex
CREATE INDEX "ChatGPTResponse_taskId_stageKey_idx" ON "ChatGPTResponse"("taskId", "stageKey");

-- CreateIndex
CREATE UNIQUE INDEX "PromptTemplate_moduleKey_stageKey_key" ON "PromptTemplate"("moduleKey", "stageKey");

-- CreateIndex
CREATE UNIQUE INDEX "PromptTemplateVersion_templateId_version_key" ON "PromptTemplateVersion"("templateId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "QueueJob_idempotencyKey_key" ON "QueueJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "QueueJob_queue_status_runAt_idx" ON "QueueJob"("queue", "status", "runAt");

-- CreateIndex
CREATE INDEX "QueueJob_taskId_idx" ON "QueueJob"("taskId");

-- CreateIndex
CREATE INDEX "QueueJob_status_leaseUntil_idx" ON "QueueJob"("status", "leaseUntil");

-- CreateIndex
CREATE INDEX "Log_createdAt_idx" ON "Log"("createdAt");

-- CreateIndex
CREATE INDEX "Log_taskId_idx" ON "Log"("taskId");

-- CreateIndex
CREATE INDEX "Log_level_createdAt_idx" ON "Log"("level", "createdAt");

-- CreateIndex
CREATE INDEX "SEOReport_taskId_source_idx" ON "SEOReport"("taskId", "source");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "WorkflowKeyword_workflowId_status_position_idx" ON "WorkflowKeyword"("workflowId", "status", "position");

-- CreateIndex
CREATE UNIQUE INDEX "SlotReservation_workflowKeywordId_key" ON "SlotReservation"("workflowKeywordId");

-- CreateIndex
CREATE UNIQUE INDEX "SlotReservation_websiteId_scheduledAt_key" ON "SlotReservation"("websiteId", "scheduledAt");

-- CreateIndex
CREATE INDEX "MediaAsset_taskId_role_idx" ON "MediaAsset"("taskId", "role");

-- CreateIndex
CREATE INDEX "MediaAsset_sha256_idx" ON "MediaAsset"("sha256");

