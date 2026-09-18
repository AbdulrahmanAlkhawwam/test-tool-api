import { Injectable } from '@nestjs/common';
import { Prisma, ResultStatus, RunStatus } from '@prisma/client';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { nextCaseCode } from '../test-cases/case-code';
import { ConfirmImportDto } from './dto/confirm-import.dto';
import { deriveModuleCode, parseImportRows, uniqueModuleCode } from './import.parser';
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
        const { modules, renamedModules } = await this.ensureModules(tx, projectId, rows);
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
            moduleId: modules.get(row.moduleCode)!.id,
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
          const code = row.code ?? nextCaseCode(modules.get(row.moduleCode)!.code, allCodes);
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
        return { created, updated, skipped, runId, renamedModules };
      },
      { timeout: 60_000 },
    );
  }

  /**
   * Finds or creates one module per module code used by valid rows.
   * Returns file code → resolved module, plus the modules that had to get a different code.
   *
   * A code taken from an ID prefix (TC-AUTH-001) always maps to that project module. A code
   * derived from the module name (rows without an ID) first matches a project module with the
   * same name (case-insensitive); otherwise, if the derived code already belongs to a module
   * with a different name, the new module gets the next free numeric suffix (UM → UM2)
   * instead of being merged into it silently.
   */
  private async ensureModules(tx: Prisma.TransactionClient, projectId: string, rows: PreviewRow[]) {
    const wanted = new Map<string, { name: string; derived: boolean }>(); // file code → module
    for (const r of rows) {
      if (!r.errors.length && !wanted.has(r.moduleCode)) wanted.set(r.moduleCode, { name: r.moduleName, derived: r.moduleCodeDerived });
    }

    const existing = await tx.projectModule.findMany({ where: { projectId }, select: { id: true, code: true, name: true } });
    const byCode = new Map(existing.map((m) => [m.code, m]));
    const byName = new Map(existing.map((m) => [m.name.toLowerCase(), m]));

    const modules = new Map<string, { id: string; code: string }>();
    const collisions: { code: string; name: string }[] = [];
    for (const [code, { name, derived }] of wanted) {
      const sameName = derived ? byName.get(name.toLowerCase()) : undefined;
      const sameCode = byCode.get(code);
      if (sameName) {
        modules.set(code, { id: sameName.id, code: sameName.code });
      } else if (sameCode && !derived) {
        modules.set(code, { id: sameCode.id, code });
      } else if (sameCode) {
        collisions.push({ code, name }); // resolved below, once every other code is known
      } else {
        const created = await tx.projectModule.create({ data: { projectId, code, name } });
        byCode.set(code, created);
        modules.set(code, { id: created.id, code });
      }
    }

    const renamedModules: { name: string; code: string }[] = [];
    for (const { code, name } of collisions) {
      const newCode = uniqueModuleCode(deriveModuleCode(name), (c) => byCode.has(c));
      const created = await tx.projectModule.create({ data: { projectId, code: newCode, name } });
      byCode.set(newCode, created);
      modules.set(code, { id: created.id, code: newCode });
      renamedModules.push({ name, code: newCode });
    }
    return { modules, renamedModules };
  }
}
