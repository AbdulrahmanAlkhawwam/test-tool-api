import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import ExcelJS from 'exceljs';
import request from 'supertest';
import type { Response } from 'superagent';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { PrismaService } from '../../src/prisma/prisma.service';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  http: () => ReturnType<typeof request>;
}

export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return {
    app,
    prisma: app.get(PrismaService),
    http: () => request(app.getHttpServer()),
  };
}

export async function resetDb(prisma: PrismaService): Promise<void> {
  // Refuse to wipe anything but a dedicated test database (e.g. when .env.test is missing
  // and DATABASE_URL falls back to the development database).
  const dbName = decodeURIComponent(new URL(process.env.DATABASE_URL ?? 'postgresql://unset/').pathname.slice(1));
  if (!dbName.endsWith('_test')) {
    throw new Error(`resetDb refuses to truncate database "${dbName}": its name must end with "_test"`);
  }
  await prisma.$executeRawUnsafe(
    'TRUNCATE "GitlabOAuthState", "GitlabConnection", "TestResult", "TestRun", "TestCase", "ProjectModule", "Project", "User" RESTART IDENTITY CASCADE',
  );
}

/** supertest parser that collects a binary body (xlsx downloads) into a Buffer. */
export function binaryParser(res: Response, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

/** Builds an in-memory .xlsx whose first sheet contains the given rows. */
export async function makeXlsx(rows: (string | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
