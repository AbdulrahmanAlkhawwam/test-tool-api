import { Injectable } from '@nestjs/common';
import { Prisma, ResultStatus, RunStatus } from '@prisma/client';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { nextCaseCode } from '../test-cases/case-code';
import { ConfirmImportDto } from './dto/confirm-import.dto';
import { parseImportRows } from './import.parser';
import { ImportStore, PreviewRow } from './import.store';
import { readTabular } from './tabular-reader';

@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly store: ImportStore,
  ) {}

  async preview(projectId: string, file: { buffer: Buffer; originalname: string }, user: AuthUser) {
    await this.projects.requireProject(projectId);
    const parsed = parseImportRows(await readTabular(file.buffer, file.originalname));
    const existing = new Set(
      (await this.prisma.testCase.findMany({ where: { projectId }, select: { code: true } })).map((c) => c.code),
    );
    const rows: PreviewRow[] = parsed.map((r) => ({ ...r, duplicate: !!r.code && existing.has(r.code) }));
    const importId = this.store.save(projectId, user.id, rows);
    return {
      importId,
      rows,
      summary: {
        total: rows.length,
        valid: rows.filter((r) => !r.errors.length).length,
        withErrors: rows.filter((r) => r.errors.length).length,
        duplicates: rows.filter((r) => r.duplicate).length,
      },
    };
  }

  async confirm(projectId: string, dto: ConfirmImportDto, user: AuthUser) {
    await this.projects.requireProject(projectId);
    const rows = this.store.take(dto.importId, projectId, user.id);

    return this.prisma.$transaction(
      async (tx) => {
        const moduleIds = await this.ensureModules(tx, projectId, rows);
        const existing = new Map(
          (await tx.testCase.findMany({ where: { projectId }, select: { id: true, code: true } })).map((c) => [c.code, c.id]),
        );
        const allCodes = new Set(existing.keys());
        const imported: { caseId: string; row: PreviewRow }[] = [];
        let created = 0;
        let updated = 0;
        let skipped = 0;

        for (const row of rows) {
          if (row.errors.length) {
            skipped++;
            continue;
          }
          const fields = {
            name: row.name,
            description: row.description,
            preconditions: row.preconditions,
            steps: row.steps,
            testData: row.testData,
            expectedResult: row.expectedResult,
            priority: row.priority,
            notes: row.notes,
            moduleId: moduleIds.get(row.moduleCode)!,
            updatedById: user.id,
          };
          const existingId = row.code ? existing.get(row.code) : undefined;
          if (existingId) {
            if (dto.duplicateStrategy === 'skip') {
              skipped++;
              continue;
            }
            await tx.testCase.update({ where: { id: existingId }, data: { ...fields, deletedAt: null } });
            imported.push({ caseId: existingId, row });
            updated++;
            continue;
          }
          const code = row.code ?? nextCaseCode(row.moduleCode, allCodes);
          allCodes.add(code);
          const testCase = await tx.testCase.create({ data: { ...fields, code, projectId, createdById: user.id } });
          imported.push({ caseId: testCase.id, row });
          created++;
        }

        let runId: string | null = null;
        if (dto.createImportedRun && imported.length) {
          const now = new Date();
          const run = await tx.testRun.create({
            data: {
              projectId,
              name: dto.runName ?? `Imported ${now.toISOString().slice(0, 10)}`,
              status: RunStatus.COMPLETED,
              completedAt: now,
              createdById: user.id,
            },
          });
          await tx.testResult.createMany({
            data: imported.map(({ caseId, row }) => {
              const executed = row.status !== ResultStatus.NOT_EXECUTED;
              return {
                runId: run.id,
                testCaseId: caseId,
                status: row.status,
                actualResult: row.actualResult,
                executedById: executed ? user.id : null,
                executedAt: executed ? now : null,
              };
            }),
          });
          runId = run.id;
        }
        return { created, updated, skipped, runId };
      },
      { timeout: 60_000 },
    );
  }

  /** Finds or creates one module per module code used by valid rows; returns code → module id. */
  private async ensureModules(tx: Prisma.TransactionClient, projectId: string, rows: PreviewRow[]) {
    const wanted = new Map<string, string>(); // code → name
    for (const r of rows) if (!r.errors.length && !wanted.has(r.moduleCode)) wanted.set(r.moduleCode, r.moduleName);

    const ids = new Map<string, string>();
    for (const [code, name] of wanted) {
      const module = await tx.projectModule.upsert({
        where: { projectId_code: { projectId, code } },
        update: {},
        create: { projectId, code, name },
      });
      ids.set(code, module.id);
    }
    return ids;
  }
}
