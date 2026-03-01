import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seed check...');
  const partsCount = await prisma.part.count();
  const categoriesCount = await prisma.partCategory.count();
  const colorsCount = await prisma.color.count();
  console.log(
    `✅ DB OK. Parts=${partsCount}, Categories=${categoriesCount}, Colors=${colorsCount}`,
  );
}

main()
  .catch((e) => {
    console.error('❌ Błąd podczas seedowania:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
