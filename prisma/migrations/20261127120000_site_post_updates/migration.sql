-- Update to latest (owner request 2026-11-27): posts read from WordPress and their update proposals. New tables and
-- one new nullable column; no existing data changes.
CREATE TABLE "SitePost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "websiteId" TEXT NOT NULL,
    "wpPostId" INTEGER NOT NULL,
    "taskId" TEXT,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "slug" TEXT,
    "status" TEXT NOT NULL,
    "categoryIds" TEXT NOT NULL DEFAULT '[]',
    "focusKeyword" TEXT,
    "seoTitle" TEXT,
    "metaDescription" TEXT,
    "contentRaw" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "editor" TEXT NOT NULL,
    "words" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" DATETIME,
    "modifiedAt" DATETIME,
    "importedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SitePost_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "PostUpdate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sitePostId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "wpPostId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "message" TEXT,
    "baseRaw" TEXT,
    "baseHash" TEXT,
    "baseTitle" TEXT,
    "baseSeoTitle" TEXT,
    "baseMeta" TEXT,
    "baseHtml" TEXT,
    "proposedHtml" TEXT,
    "proposedRaw" TEXT,
    "proposedTitle" TEXT,
    "proposedSeoTitle" TEXT,
    "proposedMeta" TEXT,
    "changes" TEXT NOT NULL DEFAULT '[]',
    "sources" TEXT NOT NULL DEFAULT '[]',
    "checks" TEXT NOT NULL DEFAULT '[]',
    "result" TEXT NOT NULL DEFAULT '{}',
    "appliedHash" TEXT,
    "conversationUrl" TEXT,
    "approvedAt" DATETIME,
    "appliedAt" DATETIME,
    "undoneAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PostUpdate_sitePostId_fkey" FOREIGN KEY ("sitePostId") REFERENCES "SitePost" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "ChatGPTResponse" ADD COLUMN "postUpdateId" TEXT;

CREATE UNIQUE INDEX "SitePost_websiteId_wpPostId_key" ON "SitePost"("websiteId", "wpPostId");
CREATE INDEX "SitePost_websiteId_modifiedAt_idx" ON "SitePost"("websiteId", "modifiedAt");
CREATE INDEX "PostUpdate_sitePostId_idx" ON "PostUpdate"("sitePostId");
CREATE INDEX "PostUpdate_websiteId_status_idx" ON "PostUpdate"("websiteId", "status");
CREATE INDEX "ChatGPTResponse_postUpdateId_idx" ON "ChatGPTResponse"("postUpdateId");
