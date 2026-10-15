-- CreateTable
CREATE TABLE "SourceRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "detail" TEXT,
    "text" TEXT NOT NULL DEFAULT '',
    "contentHash" TEXT,
    "fetchedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ClaimEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "claimType" TEXT NOT NULL,
    "claimText" TEXT NOT NULL,
    "values" TEXT NOT NULL DEFAULT '{}',
    "nature" TEXT NOT NULL,
    "highImpact" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "citations" TEXT NOT NULL DEFAULT '[]',
    "evidence" TEXT NOT NULL DEFAULT '[]',
    "articleParagraph" INTEGER,
    "ownerDecision" TEXT,
    "ownerValue" TEXT,
    "ownerNote" TEXT,
    "decidedAt" DATETIME,
    "researchedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClaimEvidence_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ArticleTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SourceRecord_url_key" ON "SourceRecord"("url");

-- CreateIndex
CREATE INDEX "SourceRecord_host_idx" ON "SourceRecord"("host");

-- CreateIndex
CREATE INDEX "ClaimEvidence_taskId_idx" ON "ClaimEvidence"("taskId");

-- CreateIndex
CREATE INDEX "ClaimEvidence_status_idx" ON "ClaimEvidence"("status");

