-- CreateTable
CREATE TABLE "Color" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "rgb" TEXT NOT NULL,
    "isTrans" BOOLEAN,

    CONSTRAINT "Color_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartColor" (
    "partId" INTEGER NOT NULL,
    "colorId" INTEGER NOT NULL,

    CONSTRAINT "PartColor_pkey" PRIMARY KEY ("partId","colorId")
);

-- AddForeignKey
ALTER TABLE "PartColor" ADD CONSTRAINT "PartColor_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartColor" ADD CONSTRAINT "PartColor_colorId_fkey" FOREIGN KEY ("colorId") REFERENCES "Color"("id") ON DELETE CASCADE ON UPDATE CASCADE;
