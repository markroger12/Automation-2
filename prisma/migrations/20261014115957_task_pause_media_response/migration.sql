-- AlterTable
ALTER TABLE "ArticleTask" ADD COLUMN "pausedFor" TEXT;

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN "responseId" TEXT;

-- CreateIndex
CREATE INDEX "MediaAsset_responseId_idx" ON "MediaAsset"("responseId");

