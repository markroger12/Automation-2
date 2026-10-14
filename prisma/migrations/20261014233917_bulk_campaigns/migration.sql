-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "defaultWriter" TEXT NOT NULL DEFAULT 'AUTO',
    "options" TEXT NOT NULL DEFAULT '{}',
    "inputText" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "routerVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUEING',
    "message" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Campaign_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CampaignRow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "line" INTEGER NOT NULL,
    "raw" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "normalizedKeyword" TEXT NOT NULL,
    "secondaryKeywords" TEXT NOT NULL DEFAULT '[]',
    "exampleTitle" TEXT,
    "websiteId" TEXT,
    "categoryId" TEXT,
    "language" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "writer" TEXT,
    "writerSource" TEXT,
    "routerConfidence" REAL,
    "routerRationale" TEXT,
    "status" TEXT NOT NULL,
    "issues" TEXT NOT NULL DEFAULT '[]',
    "confirmedVariant" BOOLEAN NOT NULL DEFAULT false,
    "taskId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CampaignRow_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Campaign_createdAt_idx" ON "Campaign"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRow_taskId_key" ON "CampaignRow"("taskId");

-- CreateIndex
CREATE INDEX "CampaignRow_campaignId_status_idx" ON "CampaignRow"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRow_campaignId_position_key" ON "CampaignRow"("campaignId", "position");

