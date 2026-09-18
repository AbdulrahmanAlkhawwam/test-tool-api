import { ResultStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type StatusCounts = Partial<Record<ResultStatus, number>>;

export interface RunSummary {
  total: number;
  executed: number;
  notExecuted: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  passRate: number;
}

export function summarize(counts: StatusCounts): RunSummary {
  const passed = counts.PASSED ?? 0;
  const failed = counts.FAILED ?? 0;
  const blocked = counts.BLOCKED ?? 0;
  const skipped = counts.SKIPPED ?? 0;
  const notExecuted = counts.NOT_EXECUTED ?? 0;
  const executed = passed + failed + blocked + skipped;
  return {
    total: executed + notExecuted,
    executed,
    notExecuted,
    passed,
    failed,
    blocked,
    skipped,
    passRate: executed ? Math.round((passed / executed) * 1000) / 10 : 0,
  };
}

export function countStatuses(statuses: ResultStatus[]): StatusCounts {
  const counts: StatusCounts = {};
  for (const s of statuses) counts[s] = (counts[s] ?? 0) + 1;
  return counts;
}

export async function loadRunSummaries(prisma: PrismaService, runIds: string[]): Promise<Map<string, RunSummary>> {
  const byRun = new Map<string, StatusCounts>();
  if (runIds.length) {
    const groups = await prisma.testResult.groupBy({
      by: ['runId', 'status'],
      where: { runId: { in: runIds } },
      _count: { _all: true },
    });
    for (const g of groups) {
      const counts = byRun.get(g.runId) ?? {};
      counts[g.status] = g._count._all;
      byRun.set(g.runId, counts);
    }
  }
  return new Map(runIds.map((id) => [id, summarize(byRun.get(id) ?? {})]));
}
