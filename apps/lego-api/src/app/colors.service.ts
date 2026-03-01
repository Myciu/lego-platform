import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from './prisma.service';

@Injectable()
export class ColorsService implements OnModuleInit {
  private readonly logger = new Logger(ColorsService.name);
  private readonly apiKey: string;
  private readonly colorsUrl = 'https://rebrickable.com/api/v3/lego/colors';
  private readonly ignoredPrefix = 'HO';

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {
    this.apiKey = this.config.get<string>('REBRICKABLE_API_KEY');
  }

  /**
   * TO JEST BEZPIECZNE ROZWIĄZANIE:
   * Wykonuje się przy starcie, ale uderza do API tylko jeśli baza jest pusta.
   */
  async onModuleInit() {
    const count = await this.prisma.color.count();

    if (count > 0) {
      const removed = await this.removeIgnoredColors();
      this.logger.log(
        `Słownik kolorów załadowany z bazy (${count} pozycji, usunięto prefiks ${this.ignoredPrefix}: ${removed}). API nie jest potrzebne.`,
      );
      return;
    }

    this.logger.warn('Baza kolorów pusta. Inicjuję pobieranie z API...');
    try {
      await this.syncAllColors();
    } catch (error) {
      this.logger.warn('Nie udało się załadować słownika kolorów przy starcie. Kontynuuję bez synchronizacji.');
    }
  }

  async syncAllColors() {
    this.logger.log('Start synchronizacji słownika kolorów z Rebrickable...');

    try {
      const allColors: { id: number; name: string; rgb: string; isTrans: boolean | null }[] = [];
      let nextUrl: string | null = `${this.colorsUrl}/?page_size=200`;

      while (nextUrl) {
        const { data } = await firstValueFrom(
          this.httpService.get(nextUrl, {
            headers: { Authorization: `key ${this.apiKey}` },
          })
        );

        const mapped = (data.results || [])
          .map((color: any) => ({
          id: color.id,
          name: color.name,
          rgb: color.rgb,
          isTrans: color.is_trans ?? null,
        }))
          .filter((color: { name: string }) => !this.isIgnoredColorName(color.name));

        allColors.push(...mapped);
        nextUrl = data.next;
      }

      await this.prisma.$transaction(
        allColors.map((color) =>
          this.prisma.color.upsert({
            where: { id: color.id },
            update: {
              name: color.name,
              rgb: color.rgb,
              isTrans: color.isTrans,
            },
            create: {
              id: color.id,
              name: color.name,
              rgb: color.rgb,
              isTrans: color.isTrans,
            },
          })
        )
      );

      const removed = await this.removeIgnoredColors();
      this.logger.log(
        `Zapisano/odświeżono ${allColors.length} kolorów (usunięto prefiks ${this.ignoredPrefix}: ${removed}).`,
      );
      return {
        message: 'Słownik kolorów został zsynchronizowany.',
        count: allColors.length - removed,
      };
    } catch (error) {
      this.logger.error('Błąd podczas synchronizacji słownika kolorów.', error.stack);
      throw error;
    }
  }

  async getAvailableColors() {
    const colors = await this.prisma.color.findMany({
      where: {
        NOT: {
          name: {
            startsWith: this.ignoredPrefix,
            mode: 'insensitive',
          },
        },
      },
      include: {
        _count: {
          select: {
            parts: true,
          },
        },
      },
    });

    return colors
      .map((color) => ({
        id: color.id,
        name: color.name,
        rgb: color.rgb,
        isTrans: color.isTrans ?? null,
        partCount: color._count.parts,
      }))
      .filter((color) => color.partCount > 0)
      .sort((a, b) => {
        if (b.partCount !== a.partCount) {
          return b.partCount - a.partCount;
        }
        return a.name.localeCompare(b.name);
      });
  }

  private isIgnoredColorName(name?: string | null): boolean {
    const normalized = String(name || '').trim().toUpperCase();
    return normalized.startsWith(this.ignoredPrefix);
  }

  private async removeIgnoredColors(): Promise<number> {
    const result = await this.prisma.color.deleteMany({
      where: {
        name: {
          startsWith: this.ignoredPrefix,
          mode: 'insensitive',
        },
      },
    });

    return result.count;
  }
}
