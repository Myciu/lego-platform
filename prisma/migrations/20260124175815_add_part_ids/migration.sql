/*
  Warnings:

  - The primary key for the `LegoSet` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `retailPrice` on the `LegoSet` table. All the data in the column will be lost.
  - You are about to drop the column `theme` on the `LegoSet` table. All the data in the column will be lost.
  - The `id` column on the `LegoSet` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `Part` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `Part` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `PartInSet` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `PartInSet` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `PartOffer` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `updatedAt` on the `PartOffer` table. All the data in the column will be lost.
  - The `id` column on the `PartOffer` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the `Alert` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Offer` table. If the table is not empty, all the data it contains will be lost.
  - Made the column `year` on table `LegoSet` required. This step will fail if there are existing NULL values in that column.
  - Changed the type of `setId` on the `PartInSet` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `partId` on the `PartInSet` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `partId` on the `PartOffer` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- DropForeignKey
ALTER TABLE "Alert" DROP CONSTRAINT "Alert_legoSetId_fkey";

-- DropForeignKey
ALTER TABLE "Offer" DROP CONSTRAINT "Offer_legoSetId_fkey";

-- DropForeignKey
ALTER TABLE "PartInSet" DROP CONSTRAINT "PartInSet_partId_fkey";

-- DropForeignKey
ALTER TABLE "PartInSet" DROP CONSTRAINT "PartInSet_setId_fkey";

-- DropForeignKey
ALTER TABLE "PartOffer" DROP CONSTRAINT "PartOffer_partId_fkey";

-- AlterTable
ALTER TABLE "LegoSet" DROP CONSTRAINT "LegoSet_pkey",
DROP COLUMN "retailPrice",
DROP COLUMN "theme",
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ALTER COLUMN "year" SET NOT NULL,
ADD CONSTRAINT "LegoSet_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "Part" DROP CONSTRAINT "Part_pkey",
ADD COLUMN     "partCatId" INTEGER,
ADD COLUMN     "partIds" JSONB,
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "Part_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "PartInSet" DROP CONSTRAINT "PartInSet_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
DROP COLUMN "setId",
ADD COLUMN     "setId" INTEGER NOT NULL,
DROP COLUMN "partId",
ADD COLUMN     "partId" INTEGER NOT NULL,
ADD CONSTRAINT "PartInSet_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "PartOffer" DROP CONSTRAINT "PartOffer_pkey",
DROP COLUMN "updatedAt",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
DROP COLUMN "partId",
ADD COLUMN     "partId" INTEGER NOT NULL,
ALTER COLUMN "price" SET DATA TYPE TEXT,
ADD CONSTRAINT "PartOffer_pkey" PRIMARY KEY ("id");

-- DropTable
DROP TABLE "Alert";

-- DropTable
DROP TABLE "Offer";

-- AddForeignKey
ALTER TABLE "PartInSet" ADD CONSTRAINT "PartInSet_setId_fkey" FOREIGN KEY ("setId") REFERENCES "LegoSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartInSet" ADD CONSTRAINT "PartInSet_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartOffer" ADD CONSTRAINT "PartOffer_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
