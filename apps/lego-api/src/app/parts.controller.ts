// apps/lego-api/src/app/parts/parts.controller.ts
import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query, Post, Body } from '@nestjs/common';
import { PartsService } from './parts.service';
import { ColorsService } from './colors.service';
import { BatchOfferRequestItem } from './parts-offers.types';

interface BatchOffersRequestBody {
  parts: BatchOfferRequestItem[];
  providers?: string[];
  refreshMissingOnly?: boolean;
  refreshMissingPartKeys?: string[];
  minSellerRatingPercent?: number;
}

@Controller('parts')
export class PartsController {
  constructor(
    private readonly partsService: PartsService,
    private readonly colorsService: ColorsService
  ) {}

  private parseCategoryIds(raw?: string) {
    return this.parseIds(raw);
  }

  private parseColorIds(raw?: string) {
    return this.parseIds(raw);
  }

  private parseIds(raw?: string) {
    if (!raw) return [];

    return raw
      .split(',')
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isInteger(value) && value > 0);
  }

  @Get()
  async getParts(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(12), ParseIntPipe) limit: number,
    @Query('search') search?: string,
    @Query('categoryIds') categoryIds?: string,
    @Query('colorIds') colorIds?: string,
  ) {
    return this.partsService.findAll(
      page,
      limit,
      search,
      this.parseCategoryIds(categoryIds),
      this.parseColorIds(colorIds)
    );
  }

  @Get('categories')
  async getCategories() {
    return this.partsService.getCategories();
  }

  @Get('colors')
  async getColors() {
    return this.partsService.getColors();
  }

  @Get('offer-sources')
  async getOfferSources() {
    return {
      sources: this.partsService.getOfferSources(),
    };
  }

  @Get('offer-index-stats')
  async getOfferIndexStats() {
    return this.partsService.getOfferIndexStats();
  }

  // NOWY ENDPOINT: Batchowe pobieranie ofert
  @Post('batch-offers')
  async getBatchOffers(
    @Body() body: BatchOffersRequestBody,
  ) {
    return this.partsService.getBatchOffers(body.parts, body.providers, {
      refreshMissingOnly: Boolean(body.refreshMissingOnly),
      refreshMissingPartKeys: Array.isArray(body.refreshMissingPartKeys)
        ? body.refreshMissingPartKeys
        : [],
      minSellerRatingPercent: Number.isFinite(Number(body.minSellerRatingPercent))
        ? Number(body.minSellerRatingPercent)
        : null,
    });
  }

  @Get('sync')
  async sync(
    @Query('search') search: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('categoryIds') categoryIds?: string,
    @Query('colorIds') colorIds?: string,
  ) {
    return this.partsService.syncAndSearch(
      search,
      page,
      limit,
      this.parseCategoryIds(categoryIds),
      this.parseColorIds(colorIds)
    );
  }

  @Get('sync-full')
  async triggerFullSync() {
    return this.partsService.syncFullDatabase();
  }

  @Get('clear-all')
  async clearAll() {
    return this.partsService.clearAllParts();
  }

  @Get('sync-colors-dict')
  async syncColorsDict() {
    return this.colorsService.syncAllColors();
  }

  @Get('sync-missing-colors')
  async syncMissingColors() {
    return this.partsService.syncMissingColors();
  }
}
