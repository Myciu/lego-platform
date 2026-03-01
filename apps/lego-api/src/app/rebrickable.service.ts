// apps/lego-api/src/app/parts/rebrickable.service.ts
import { Injectable, NotFoundException } from '@nestjs/common'; // Usuń OnModuleInit
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

interface RebrickableCategory {
  id: number;
  name: string;
  part_count: number;
}

@Injectable()
export class RebrickableService {
  private readonly apiKey: string;
  private readonly partsUrl = 'https://rebrickable.com/api/v3/lego/parts';
  private readonly partCategoriesUrl = 'https://rebrickable.com/api/v3/lego/part_categories';
  // colorsUrl już tu niepotrzebny, przenosimy do ColorsService
  
  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService
  ) {
    this.apiKey = this.config.get<string>('REBRICKABLE_API_KEY');
  }

  // To służy tylko do szukania klocków (np. "Brick 1x2")
  async searchParts(params: { page?: number; limit?: number; search?: string }) {
    const { page = 1, limit = 20, search } = params;
    let url = `${this.partsUrl}/?page=${page}&page_size=${limit}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;

    try {
      const { data } = await firstValueFrom(
        this.httpService.get(url, { headers: { Authorization: `key ${this.apiKey}` } })
      );
      return {
        count: data.count,
        next: data.next,
        results: data.results.map((p: any) => ({
          designId: p.part_num,
          name: p.name,
          imageUrl: p.part_img_url,
          partCatId: p.part_cat_id,
          partIds: p.external_ids || {}, 
        })),
      };
    } catch (error) {
      throw new NotFoundException('Błąd Rebrickable API lub limit zapytań');
    }
  }

  /**
   * Pobiera listę ID kolorów dla danego klocka.
   * Nie wzbogaca ich już o RGB! (RGB mamy w bazie w tabeli Color)
   */
  async getPartColors(designId: string) {
    const url = `${this.partsUrl}/${designId}/colors/`;
    try {
      const { data } = await firstValueFrom(
        this.httpService.get(url, { headers: { Authorization: `key ${this.apiKey}` } })
      );
      
      return {
        count: data.count,
        results: data.results.map((c: any) => ({
          color_id: c.color_id, // Tylko ID nas interesuje
          // Nazwę i RGB weźmiemy sobie z naszej bazy przez relację
        })),
      };
    } catch (error) {
      // Jeśli 404 lub błąd, zwracamy pustą listę
      return { count: 0, results: [] };
    }
  }

  async getPartCategories() {
    const allCategories: RebrickableCategory[] = [];
    let nextUrl: string | null = `${this.partCategoriesUrl}/?page_size=100`;

    try {
      while (nextUrl) {
        const { data } = await firstValueFrom(
          this.httpService.get(nextUrl, {
            headers: { Authorization: `key ${this.apiKey}` },
          })
        );

        allCategories.push(...(data.results || []));
        nextUrl = data.next;
      }

      return allCategories.map((category) => ({
        id: category.id,
        name: category.name,
        partCount: category.part_count,
      }));
    } catch (error) {
      throw new NotFoundException('Nie udało się pobrać kategorii części z Rebrickable');
    }
  }
}
