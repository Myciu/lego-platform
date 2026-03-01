-- CreateTable
CREATE TABLE "LegoSet" (
    "id" TEXT NOT NULL,
    "setNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "theme" TEXT NOT NULL,
    "imageUrl" TEXT,
    "retailPrice" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegoSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "storeName" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "inStock" BOOLEAN NOT NULL DEFAULT true,
    "legoSetId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "userEmail" TEXT NOT NULL,
    "targetPrice" DOUBLE PRECISION NOT NULL,
    "legoSetId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LegoSet_setNumber_key" ON "LegoSet"("setNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Offer_legoSetId_storeName_key" ON "Offer"("legoSetId", "storeName");

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_legoSetId_fkey" FOREIGN KEY ("legoSetId") REFERENCES "LegoSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_legoSetId_fkey" FOREIGN KEY ("legoSetId") REFERENCES "LegoSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
