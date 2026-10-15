-- CreateTable
CREATE TABLE "ContentFingerprint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'PARAGRAPH',
    "hash" TEXT NOT NULL,
    "words" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContentFingerprint_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ArticleTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DuplicateMatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "otherTaskId" TEXT NOT NULL,
    "otherTitle" TEXT NOT NULL,
    "otherWebsite" TEXT NOT NULL,
    "sameWebsite" BOOLEAN NOT NULL,
    "severity" TEXT NOT NULL,
    "wordingWords" INTEGER NOT NULL,
    "factWords" INTEGER NOT NULL,
    "longestRun" INTEGER NOT NULL,
    "nearSentences" INTEGER NOT NULL,
    "exactParagraphs" INTEGER NOT NULL,
    "wordingShare" REAL NOT NULL,
    "excerpts" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DuplicateMatch_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ArticleTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ArticleQualityReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "hardStops" TEXT NOT NULL DEFAULT '[]',
    "warnings" TEXT NOT NULL DEFAULT '[]',
    "sections" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArticleQualityReport_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ArticleTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Website" (
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
    "routingRules" TEXT NOT NULL DEFAULT '[]',
    "promptOverrides" TEXT NOT NULL DEFAULT '{}',
    "linkStrategy" TEXT NOT NULL DEFAULT '{}',
    "queueQuota" INTEGER NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "rankMathTarget" INTEGER,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "linkIndexSyncedAt" DATETIME,
    "linkIndexFullSyncAt" DATETIME,
    CONSTRAINT "Website_wordpressProfileId_fkey" FOREIGN KEY ("wordpressProfileId") REFERENCES "BrowserProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Website" ("active", "adminUrl", "allowLiveUpdates", "canPublish", "canPublishAcknowledgedAt", "createdAt", "defaultCategoryId", "detectedEditor", "editorType", "id", "imageSettings", "imageTemplate", "internalLinkLine", "language", "linkIndexFullSyncAt", "linkIndexSyncedAt", "linkStrategy", "logoPath", "name", "notes", "paused", "priority", "promptOverrides", "publicUrl", "queueQuota", "rankMathTarget", "searchConsoleProperty", "settingsOverrides", "slug", "targetCountry", "timezone", "updatedAt", "wordpressProfileId") SELECT "active", "adminUrl", "allowLiveUpdates", "canPublish", "canPublishAcknowledgedAt", "createdAt", "defaultCategoryId", "detectedEditor", "editorType", "id", "imageSettings", "imageTemplate", "internalLinkLine", "language", "linkIndexFullSyncAt", "linkIndexSyncedAt", "linkStrategy", "logoPath", "name", "notes", "paused", "priority", "promptOverrides", "publicUrl", "queueQuota", "rankMathTarget", "searchConsoleProperty", "settingsOverrides", "slug", "targetCountry", "timezone", "updatedAt", "wordpressProfileId" FROM "Website";
DROP TABLE "Website";
ALTER TABLE "new_Website" RENAME TO "Website";
CREATE UNIQUE INDEX "Website_slug_key" ON "Website"("slug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ContentFingerprint_hash_idx" ON "ContentFingerprint"("hash");

-- CreateIndex
CREATE INDEX "ContentFingerprint_taskId_idx" ON "ContentFingerprint"("taskId");

-- CreateIndex
CREATE INDEX "DuplicateMatch_taskId_idx" ON "DuplicateMatch"("taskId");

-- CreateIndex
CREATE INDEX "DuplicateMatch_status_severity_idx" ON "DuplicateMatch"("status", "severity");

-- CreateIndex
CREATE INDEX "ArticleQualityReport_taskId_createdAt_idx" ON "ArticleQualityReport"("taskId", "createdAt");

