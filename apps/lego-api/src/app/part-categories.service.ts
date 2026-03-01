import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { RebrickableService } from './rebrickable.service';

@Injectable()
export class PartCategoriesService implements OnModuleInit {
  private readonly logger = new Logger(PartCategoriesService.name);
  private categoriesTableAvailable = true;

  private readonly defaultCategoryNames = [
    'Bricks',
    'Tiles',
    'Bricks Sloped',
    'Bricks Curved',
    'Plates',
    'Plates Special',
    'Tiles Special',
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly rebrickable: RebrickableService
  ) {}

  isCategoriesTableAvailable() {
    return this.categoriesTableAvailable;
  }

  private isMissingPartCategoryTableError(error: unknown) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
      return false;
    }

    return (
      error.code === 'P2021' &&
      typeof error.meta?.['table'] === 'string' &&
      String(error.meta['table']).includes('PartCategory')
    );
  }

  async onModuleInit() {
    let count = 0;
    let unknownCount = 0;

    try {
      [count, unknownCount] = await this.prisma.$transaction([
        this.prisma.partCategory.count(),
        this.prisma.partCategory.count({ where: { name: 'Unknown' } }),
      ]);
    } catch (error) {
      if (this.isMissingPartCategoryTableError(error)) {
        this.categoriesTableAvailable = false;
        this.logger.warn(
          'Tabela PartCategory nie istnieje w tej bazie. Uruchom migracje Prisma, aby aktywować filtry kategorii.'
        );
        return;
      }

      this.logger.error('Nie udało się odczytać statusu tabeli kategorii.', error);
      return;
    }

    if (count > 0 && unknownCount === 0) {
      this.logger.log(`Kategorie części załadowane z bazy (${count} pozycji).`);
      return;
    }

    this.logger.log(
      'Kategorie części wymagają inicjalizacji lub odświeżenia. Pobieram listę z Rebrickable...'
    );

    try {
      const categories = await this.rebrickable.getPartCategories();

      if (categories.length === 0) {
        this.logger.warn('Rebrickable zwróciło pustą listę kategorii.');
        return;
      }

      await this.prisma.$transaction(
        categories.map((category) =>
          this.prisma.partCategory.upsert({
            where: { id: category.id },
            update: {
              name: category.name,
              partCount: category.partCount,
            },
            create: {
              id: category.id,
              name: category.name,
              partCount: category.partCount,
            },
          })
        )
      );

      this.logger.log(`Zapisano ${categories.length} kategorii części.`);
    } catch (error) {
      this.logger.error('Nie udało się zsynchronizować kategorii części.', error.stack);
    }
  }

  async getAll() {
    if (!this.categoriesTableAvailable) {
      return [];
    }

    let categories;
    try {
      categories = await this.prisma.partCategory.findMany({
        orderBy: [{ partCount: 'desc' }, { name: 'asc' }],
      });
    } catch (error) {
      if (this.isMissingPartCategoryTableError(error)) {
        this.categoriesTableAvailable = false;
        return [];
      }

      throw error;
    }

    return categories.map((category) => ({
      id: category.id,
      name: category.name,
      partCount: category.partCount,
      isDefault: this.defaultCategoryNames.includes(category.name),
    }));
  }
}
