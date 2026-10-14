-- CreateTable
CREATE TABLE "HumanizerRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT,
    "source" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "keyword" TEXT NOT NULL DEFAULT '',
    "scope" TEXT NOT NULL DEFAULT 'all',
    "promptOverride" TEXT,
    "inputHtml" TEXT NOT NULL,
    "baselineHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "message" TEXT,
    "result" TEXT NOT NULL DEFAULT '{}',
    "outputHtml" TEXT,
    "appliedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HumanizerRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ArticleTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ChatGPTResponse" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT,
    "runId" TEXT,
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
    CONSTRAINT "ChatGPTResponse_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ArticleTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChatGPTResponse_runId_fkey" FOREIGN KEY ("runId") REFERENCES "HumanizerRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ChatGPTResponse" ("attempt", "completedAt", "conversationSwitch", "conversationUrl", "createdAt", "elapsedMs", "error", "id", "jobId", "operationId", "promptHash", "recovered", "renderedPrompt", "responseFingerprint", "resultHtml", "resultText", "reused", "stageKey", "status", "taskId") SELECT "attempt", "completedAt", "conversationSwitch", "conversationUrl", "createdAt", "elapsedMs", "error", "id", "jobId", "operationId", "promptHash", "recovered", "renderedPrompt", "responseFingerprint", "resultHtml", "resultText", "reused", "stageKey", "status", "taskId" FROM "ChatGPTResponse";
DROP TABLE "ChatGPTResponse";
ALTER TABLE "new_ChatGPTResponse" RENAME TO "ChatGPTResponse";
CREATE UNIQUE INDEX "ChatGPTResponse_operationId_key" ON "ChatGPTResponse"("operationId");
CREATE INDEX "ChatGPTResponse_taskId_stageKey_idx" ON "ChatGPTResponse"("taskId", "stageKey");
CREATE INDEX "ChatGPTResponse_runId_idx" ON "ChatGPTResponse"("runId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "HumanizerRun_taskId_idx" ON "HumanizerRun"("taskId");

-- CreateIndex
CREATE INDEX "HumanizerRun_createdAt_idx" ON "HumanizerRun"("createdAt");

