-- CreateTable
CREATE TABLE "SearchPerformanceSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "websiteId" TEXT NOT NULL,
    "property" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'GSC_EXPORT',
    "searchType" TEXT NOT NULL DEFAULT 'web',
    "fileName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "compare" BOOLEAN NOT NULL DEFAULT false,
    "dateFilter" TEXT,
    "pageRows" INTEGER NOT NULL DEFAULT 0,
    "queryRows" INTEGER NOT NULL DEFAULT 0,
    "dateRows" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '[]',
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SearchPerformanceSnapshot_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SearchPerformanceRow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "ctr" REAL,
    "position" REAL,
    "prevClicks" INTEGER,
    "prevImpressions" INTEGER,
    "prevCtr" REAL,
    "prevPosition" REAL,
    CONSTRAINT "SearchPerformanceRow_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "SearchPerformanceSnapshot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RefreshCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "websiteId" TEXT NOT NULL,
    "taskId" TEXT,
    "wpPostId" INTEGER,
    "url" TEXT,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "reasons" TEXT NOT NULL DEFAULT '[]',
    "signature" TEXT NOT NULL DEFAULT '',
    "live" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "evaluatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RefreshCandidate_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RefreshCandidate_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ArticleTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ContentRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT,
    "taskId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "wpPostId" INTEGER,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "baseHtml" TEXT NOT NULL,
    "baseHash" TEXT NOT NULL,
    "proposedHtml" TEXT NOT NULL,
    "changes" TEXT NOT NULL DEFAULT '[]',
    "note" TEXT,
    "remoteSnapshot" TEXT,
    "result" TEXT NOT NULL DEFAULT '{}',
    "approvedAt" DATETIME,
    "appliedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ContentRevision_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "RefreshCandidate" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ContentRevision_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ArticleTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SearchPerformanceSnapshot_websiteId_endDate_idx" ON "SearchPerformanceSnapshot"("websiteId", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "SearchPerformanceSnapshot_websiteId_sha256_key" ON "SearchPerformanceSnapshot"("websiteId", "sha256");

-- CreateIndex
CREATE INDEX "SearchPerformanceRow_websiteId_dimension_key_idx" ON "SearchPerformanceRow"("websiteId", "dimension", "key");

-- CreateIndex
CREATE INDEX "SearchPerformanceRow_snapshotId_dimension_idx" ON "SearchPerformanceRow"("snapshotId", "dimension");

-- CreateIndex
CREATE INDEX "RefreshCandidate_websiteId_status_priority_idx" ON "RefreshCandidate"("websiteId", "status", "priority");

-- CreateIndex
CREATE INDEX "RefreshCandidate_taskId_idx" ON "RefreshCandidate"("taskId");

-- CreateIndex
CREATE INDEX "ContentRevision_taskId_createdAt_idx" ON "ContentRevision"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "ContentRevision_status_idx" ON "ContentRevision"("status");

