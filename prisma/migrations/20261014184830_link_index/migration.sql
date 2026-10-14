-- AlterTable
ALTER TABLE "Website" ADD COLUMN "linkIndexFullSyncAt" DATETIME;
ALTER TABLE "Website" ADD COLUMN "linkIndexSyncedAt" DATETIME;

-- CreateTable
CREATE TABLE "LinkTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "websiteId" TEXT NOT NULL,
    "wpPostId" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT,
    "categoryIds" TEXT NOT NULL DEFAULT '[]',
    "keyword" TEXT,
    "excerpt" TEXT,
    "publishedAt" DATETIME,
    "modifiedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastCheckedAt" DATETIME,
    "checkNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LinkTarget_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "LinkTarget_websiteId_status_idx" ON "LinkTarget"("websiteId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LinkTarget_websiteId_wpPostId_key" ON "LinkTarget"("websiteId", "wpPostId");

