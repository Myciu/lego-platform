/*
  Warnings:

  - You are about to drop the `LegoSet` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PartInSet` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PartOffer` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `updatedAt` to the `Part` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "PartInSet" DROP CONSTRAINT "PartInSet_partId_fkey";

-- DropForeignKey
ALTER TABLE "PartInSet" DROP CONSTRAINT "PartInSet_setId_fkey";

-- DropForeignKey
ALTER TABLE "PartOffer" DROP CONSTRAINT "PartOffer_partId_fkey";

-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- DropTable
DROP TABLE "LegoSet";

-- DropTable
DROP TABLE "PartInSet";

-- DropTable
DROP TABLE "PartOffer";
