import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Ładujemy env z roota projektu: najpierw .env.local, potem fallback do .env.
const projectRoot = path.join(__dirname, '../../..');
const envCandidates = ['.env.local', '.env'].map((fileName) =>
  path.join(projectRoot, fileName),
);
for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SetsModule } from './app/sets.module';

async function bootstrap() {
  const app = await NestFactory.create(SetsModule);
  
  const globalPrefix = 'api';
  app.setGlobalPrefix(globalPrefix);
  
  // Włączamy CORS, aby Angular mógł bez problemu pytać o dane
  app.enableCors();

  const port = process.env.PORT || 3000;
  await app.listen(port);
  
  Logger.log(
    `🚀 Serwer działa na: http://localhost:${port}/${globalPrefix}/sets`
  );
  
  // Log pomocniczy - sprawdzisz w terminalu czy baza jest wczytana
  if (process.env['DATABASE_URL']) {
    Logger.log('✅ Zmienna DATABASE_URL została wczytana poprawnie.');
  } else {
    Logger.error('❌ BŁĄD: Nie znaleziono DATABASE_URL w konfiguracji środowiska!');
  }
}

bootstrap();
