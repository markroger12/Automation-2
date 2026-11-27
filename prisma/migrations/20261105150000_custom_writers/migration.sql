-- Writers the owner builds in the app (Writers → New writer). New table only; no data change.
CREATE TABLE "CustomWriter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "base" TEXT NOT NULL,
    "startedFrom" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "config" TEXT NOT NULL DEFAULT '{}',
    "lastTest" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "CustomWriter_key_key" ON "CustomWriter"("key");
CREATE INDEX "CustomWriter_status_idx" ON "CustomWriter"("status");
