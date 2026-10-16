-- Search Console proof of indexing: next URL-inspection check per published keyword (ADD COLUMN; no data change).
ALTER TABLE "WorkflowKeyword" ADD COLUMN "indexCheckAt" DATETIME;
ALTER TABLE "WorkflowKeyword" ADD COLUMN "indexChecks" INTEGER NOT NULL DEFAULT 0;
