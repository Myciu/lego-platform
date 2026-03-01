-- CreateTable
CREATE TABLE "PartCategory" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "partCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Part_partCatId_idx" ON "Part"("partCatId");

-- Preserve existing references before enabling foreign key
INSERT INTO "PartCategory" ("id", "name", "partCount", "createdAt", "updatedAt")
SELECT DISTINCT "partCatId", 'Unknown', 0, NOW(), NOW()
FROM "Part"
WHERE "partCatId" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

-- AddForeignKey
ALTER TABLE "Part" ADD CONSTRAINT "Part_partCatId_fkey" FOREIGN KEY ("partCatId") REFERENCES "PartCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
