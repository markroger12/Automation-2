-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN "uploadStartedAt" DATETIME;

-- CreateTable
CREATE TABLE "SiteHealthObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "websiteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "durationMs" INTEGER,
    "taskId" TEXT,
    "details" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SiteHealthObservation_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SiteHealthObservation_websiteId_kind_createdAt_idx" ON "SiteHealthObservation"("websiteId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "SiteHealthObservation_websiteId_createdAt_idx" ON "SiteHealthObservation"("websiteId", "createdAt");

