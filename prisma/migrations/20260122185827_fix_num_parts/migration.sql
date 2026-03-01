/*
  Warnings:

  - You are about to drop the column `createdAt` on the `Alert` table. All the data in the column will be lost.
  - You are about to drop the column `isActive` on the `Alert` table. All the data in the column will be lost.
  - You are about to alter the column `targetPrice` on the `Alert` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(10,2)`.
  - You are about to drop the column `createdAt` on the `LegoSet` table. All the data in the column will be lost.
  - You are about to alter the column `retailPrice` on the `LegoSet` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(10,2)`.
  - You are about to drop the column `inStock` on the `Offer` table. All the data in the column will be lost.
  - You are about to alter the column `price` on the `Offer` table. The data in that column could be lost. The data in that column will be cast from `DoublePrecision` to `Decimal(10,2)`.
  - Added the required column `numParts` to the `LegoSet` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Alert" DROP CONSTRAINT "Alert_legoSetId_fkey";

-- DropForeignKey
ALTER TABLE "Offer" DROP CONSTRAINT "Offer_legoSetId_fkey";

-- DropIndex
DROP INDEX "Offer_legoSetId_storeName_key";

-- AlterTable
ALTER TABLE "Alert" DROP COLUMN "createdAt",
DROP COLUMN "isActive",
ALTER COLUMN "targetPrice" SET DATA TYPE DECIMAL(10,2);

-- AlterTable
ALTER TABLE "LegoSet" DROP COLUMN "createdAt",
ADD COLUMN     "numParts" INTEGER NOT NULL,
ADD COLUMN     "year" INTEGER,
ALTER COLUMN "theme" DROP NOT NULL,
ALTER COLUMN "retailPrice" DROP NOT NULL,
ALTER COLUMN "retailPrice" SET DATA TYPE DECIMAL(10,2);

-- AlterTable
ALTER TABLE "Offer" DROP COLUMN "inStock",
ALTER COLUMN "price" SET DATA TYPE DECIMAL(10,2);

-- CreateTable
CREATE TABLE "Part" (
    "id" TEXT NOT NULL,
    "designId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT,

    CONSTRAINT "Part_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartInSet" (
    "id" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "colorId" INTEGER,

    CONSTRAINT "PartInSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartOffer" (
    "id" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "sellerName" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "isSmart" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Part_designId_key" ON "Part"("designId");

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_legoSetId_fkey" FOREIGN KEY ("legoSetId") REFERENCES "LegoSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartInSet" ADD CONSTRAINT "PartInSet_setId_fkey" FOREIGN KEY ("setId") REFERENCES "LegoSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartInSet" ADD CONSTRAINT "PartInSet_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartOffer" ADD CONSTRAINT "PartOffer_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_legoSetId_fkey" FOREIGN KEY ("legoSetId") REFERENCES "LegoSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
