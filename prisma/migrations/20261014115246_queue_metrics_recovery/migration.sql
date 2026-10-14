-- CreateTable
CREATE TABLE "ProductionMetric" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "taskId" TEXT,
    "stageKey" TEXT,
    "moduleKey" TEXT,
    "websiteId" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "outcome" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "waitMs" INTEGER NOT NULL DEFAULT 0,
    "details" TEXT NOT NULL DEFAULT '{}',
    "dedupeKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RecoveryIncident" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "jobId" TEXT,
    "taskId" TEXT,
    "stageKey" TEXT,
    "description" TEXT NOT NULL,
    "evidence" TEXT NOT NULL DEFAULT '{}',
    "resolution" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductionMetric_dedupeKey_key" ON "ProductionMetric"("dedupeKey");

-- CreateIndex
CREATE INDEX "ProductionMetric_kind_endedAt_idx" ON "ProductionMetric"("kind", "endedAt");

-- CreateIndex
CREATE INDEX "ProductionMetric_taskId_idx" ON "ProductionMetric"("taskId");

-- CreateIndex
CREATE INDEX "ProductionMetric_websiteId_kind_endedAt_idx" ON "ProductionMetric"("websiteId", "kind", "endedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryIncident_dedupeKey_key" ON "RecoveryIncident"("dedupeKey");

-- CreateIndex
CREATE INDEX "RecoveryIncident_status_createdAt_idx" ON "RecoveryIncident"("status", "createdAt");

-- CreateIndex
CREATE INDEX "RecoveryIncident_taskId_idx" ON "RecoveryIncident"("taskId");

