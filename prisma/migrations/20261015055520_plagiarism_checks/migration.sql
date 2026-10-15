-- CreateTable
CREATE TABLE "PlagiarismCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT,
    "source" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "keyword" TEXT NOT NULL DEFAULT '',
    "inputHtml" TEXT NOT NULL,
    "options" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "message" TEXT,
    "progress" TEXT,
    "result" TEXT NOT NULL DEFAULT '{}',
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PlagiarismCheck_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ArticleTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PlagiarismCheck_taskId_idx" ON "PlagiarismCheck"("taskId");

-- CreateIndex
CREATE INDEX "PlagiarismCheck_createdAt_idx" ON "PlagiarismCheck"("createdAt");

