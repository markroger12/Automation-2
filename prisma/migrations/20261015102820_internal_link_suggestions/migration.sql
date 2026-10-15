-- CreateTable
CREATE TABLE "SuggestedInternalLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "targetId" TEXT,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "anchor" TEXT,
    "score" REAL NOT NULL,
    "reasons" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SuggestedInternalLink_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ArticleTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SuggestedInternalLink_taskId_idx" ON "SuggestedInternalLink"("taskId");

