import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaService } from './prisma.service';
import { RebrickableService } from './rebrickable.service';
import { AllegroService } from './allegro.service';
import { ConfigModule } from '@nestjs/config';
import { PartsService } from './parts.service';
import { PartsController } from './parts.controller';
import { ColorsService } from './colors.service';
import { PartCategoriesService } from './part-categories.service';
import { EbayService } from './ebay.service';
import { BrickowlService } from './brickowl.service';
import { ErliService } from './erli.service';
import { ProviderTrafficGuardService } from './provider-traffic-guard.service';
import { OfferIndexService } from './offer-index.service';
import { OfferProviderGateway } from './offer-provider.gateway';

@Module({
  imports: [HttpModule, ConfigModule],
  controllers: [PartsController],
  providers: [
    PartsService,
    PrismaService,
    RebrickableService,
    AllegroService,
    EbayService,
    ErliService,
    BrickowlService,
    ColorsService,
    PartCategoriesService,
    ProviderTrafficGuardService,
    OfferIndexService,
    OfferProviderGateway,
  ],
})
export class SetsModule {}
