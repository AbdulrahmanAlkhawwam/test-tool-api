import { ResultStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface LatestResult {
  testCaseId: string;
  status: ResultStatus;
  actualResult: string | null;
  executedAt: Date | null;
  runId: string;
  runName: string;
}

/** Most recent executed (status ≠ NOT_EXECUTED) result for every case in the project, keyed by case id. */
export async function getLatestExecutedResults(prisma: PrismaService, projectId: string): Promise<Map<string, LatestResult>> {
  const rows = await prisma.$queryRaw<LatestResult[]>`
    SELECT DISTINCT ON (r."testCaseId")
      r."testCaseId"   AS "testCaseId",
      r.status::text   AS "status",
      r."actualResult" AS "actualResult",
      r."executedAt"   AS "executedAt",
      t.id             AS "runId",
      t.name           AS "runName"
    FROM "TestResult" r
    JOIN "TestRun" t ON t.id = r."runId"
    WHERE t."projectId" = ${projectId}
      AND r."testCaseId" IS NOT NULL
      AND r.status <> 'NOT_EXECUTED'
    ORDER BY r."testCaseId", r."executedAt" DESC NULLS LAST, t."startedAt" DESC`;
  return new Map(rows.map((r) => [r.testCaseId, r]));
}
