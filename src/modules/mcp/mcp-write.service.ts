import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CreatedVia, Priority, ReviewState } from '@prisma/client';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { deriveModuleCode, uniqueModuleCode } from '../import-export/import.parser';
import { ProjectModulesService } from '../project-modules/project-modules.service';
import { ProjectsService } from '../projects/projects.service';
import {
  buildSuggestionChanges,
  changesToUpdateData,
  ProposedFields,
  SuggestionField,
} from '../suggestions/suggestion-diff';
import { SuggestionsService } from '../suggestions/suggestions.service';
import { CreateTestCaseDto } from '../test-cases/dto/create-test-case.dto';
import { UpdateTestCaseDto } from '../test-cases/dto/update-test-case.dto';
import { TestCasesService } from '../test-cases/test-cases.service';
import { toolErrorMessage } from './tool-result';

/** Spec §6: at most 50 cases per create_test_cases call. */
export const MAX_CASES_PER_CALL = 50;

/** Mirrors CreateTestCaseDto's limits: the batch validates each item itself (see validateCase). */
const MAX_NAME = 300;
const MAX_TEXT = 5000;
const MAX_STEPS = 10_000;
const MODULE_CODE_RE = /^[A-Z][A-Z0-9]{0,9}$/;
const MODULE_CODE_MESSAGE = 'code must be 1–10 uppercase letters/digits, starting with a letter';

export interface CreateCaseInput {
  moduleCode: string;
  name: string;
  description?: string | null;
  preconditions?: string | null;
  steps?: string | null;
  testData?: string | null;
  expectedResult?: string | null;
  priority?: Priority;
  notes?: string | null;
}

export interface CreateCaseResult {
  ok: boolean;
  code?: string;
  error?: string;
}

const AI_ORIGIN = { reviewState: ReviewState.AI_DRAFT, createdVia: CreatedVia.AI } as const;

/**
 * `deriveModuleCode` (shared with import) only cares about being short and recognisable — it can
 * legitimately return something like '2L' for "2FA Login", which fails MODULE_CODE_RE's
 * letter-first rule. MODULE_CODE_RE is only ever applied to a code the *caller* supplied
 * (createModule below); a derived code is repaired here instead, so the AI never gets an error
 * about a parameter it never sent, and this path stays free to diverge from import's (which does
 * not apply the regex at all).
 */
export function repairDerivedModuleCode(code: string): string {
  if (MODULE_CODE_RE.test(code)) return code;
  const alnum = code.replace(/[^A-Z0-9]/g, '');
  const fixed = /^[A-Z]/.test(alnum) ? alnum : `M${alnum}`;
  return fixed.slice(0, 10) || 'MOD';
}

/** Per-item validation for a batch create, so one bad case cannot fail the other 49. */
export function validateCase(input: CreateCaseInput): string | null {
  if (typeof input.name !== 'string' || input.name.trim().length < 1 || input.name.length > MAX_NAME) {
    return `name must be between 1 and ${MAX_NAME} characters`;
  }
  const limits: [keyof CreateCaseInput, number][] = [
    ['description', MAX_TEXT],
    ['preconditions', MAX_TEXT],
    ['steps', MAX_STEPS],
    ['testData', MAX_TEXT],
    ['expectedResult', MAX_TEXT],
    ['notes', MAX_TEXT],
  ];
  for (const [field, max] of limits) {
    const value = input[field];
    if (typeof value === 'string' && value.length > max) return `${field} must be at most ${max} characters`;
  }
  return null;
}

/** Writes an AI is allowed to make: create a module, create drafts, propose an edit. */
@Injectable()
export class McpWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly modules: ProjectModulesService,
    private readonly testCases: TestCasesService,
    private readonly suggestions: SuggestionsService,
  ) {}

  /** Derives the code from the name the way import does, when the AI does not supply one. */
  async createModule(projectKey: string, name: string, code: string | undefined) {
    const project = await this.projects.getByKey(projectKey);
    const supplied = code?.trim().toUpperCase();
    let wanted: string;
    if (supplied) {
      // A caller-supplied code must satisfy the regex, or the AI learns its call was rejected.
      if (!MODULE_CODE_RE.test(supplied)) throw new BadRequestException(MODULE_CODE_MESSAGE);
      wanted = supplied;
    } else {
      // A derived code is repaired instead of validated: it is never allowed to fail here.
      const taken = new Set(project.modules.map((m) => m.code));
      wanted = uniqueModuleCode(repairDerivedModuleCode(deriveModuleCode(name)), (c) => taken.has(c));
    }
    const created = await this.modules.create(project.id, { name, code: wanted });
    return { name: created.name, code: created.code };
  }

  /**
   * Creates one AI draft per item, in order and one at a time: the codes are allocated from the
   * highest existing number, so two creates must not race each other inside one call. A failing
   * item is reported and skipped; the rest are still created (spec §6).
   */
  async createTestCases(projectKey: string, cases: CreateCaseInput[], user: AuthUser) {
    const project = await this.projects.getByKey(projectKey);
    const moduleIds = new Map(project.modules.map((m) => [m.code, m.id]));

    const results: CreateCaseResult[] = [];
    for (const input of cases) {
      const moduleCode = String(input.moduleCode ?? '').trim().toUpperCase();
      const moduleId = moduleIds.get(moduleCode);
      if (!moduleId) {
        results.push({ ok: false, error: `Module "${moduleCode}" was not found in project ${project.key}` });
        continue;
      }
      const invalid = validateCase(input);
      if (invalid) {
        results.push({ ok: false, error: invalid });
        continue;
      }
      const dto: CreateTestCaseDto = {
        moduleId,
        name: input.name.trim(),
        description: input.description ?? undefined,
        preconditions: input.preconditions ?? undefined,
        steps: input.steps ?? undefined,
        testData: input.testData ?? undefined,
        expectedResult: input.expectedResult ?? undefined,
        priority: input.priority,
        notes: input.notes ?? undefined,
      };
      try {
        const created = await this.testCases.create(project.id, dto, user, { origin: AI_ORIGIN });
        results.push({ ok: true, code: created.code });
      } catch (e) {
        // toolErrorMessage keeps a deliberate HttpException's message (e.g. a duplicate name) but
        // falls back to a fixed, safe string for anything else — a raw Prisma error's message
        // carries the invocation callsite and a source frame, which must never reach an AI client.
        results.push({ ok: false, error: toolErrorMessage(e) });
      }
    }
    return {
      created: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }

  /**
   * An AI draft is the AI's own work in progress, so its edits land directly. An approved case
   * belongs to the humans who approved it, so the edit becomes a pending suggestion instead
   * (spec §6). Either way only template fields move: anything else in `changes` is dropped by
   * buildSuggestionChanges, so a code, module or reviewState can never travel through here.
   */
  async updateTestCase(
    projectKey: string,
    code: string,
    changes: ProposedFields,
    rationale: string | undefined,
    user: AuthUser,
  ): Promise<{ applied: boolean; suggestionId?: string; changed?: string[]; reason?: string }> {
    const project = await this.projects.getByKey(projectKey);
    const upper = code.trim().toUpperCase();
    const existing = await this.prisma.testCase.findFirst({
      where: { projectId: project.id, code: upper, deletedAt: null },
      select: {
        id: true,
        reviewState: true,
        name: true,
        description: true,
        preconditions: true,
        steps: true,
        testData: true,
        expectedResult: true,
        priority: true,
        notes: true,
      },
    });
    if (!existing) throw new NotFoundException(`Test case "${upper}" was not found in project ${project.key}`);

    const diff = buildSuggestionChanges(existing, changes);
    const changed = Object.keys(diff) as SuggestionField[];
    if (!changed.length) {
      // `changes` here is already the zod-parsed input: a call whose only keys were non-template
      // fields (code, moduleCode, reviewState, ...) arrives with every one of them stripped, i.e.
      // an empty object — distinct from a template field that was given but already holds that
      // value, which deserves its own, more accurate reason.
      if (!Object.keys(changes).length) return { applied: false, reason: 'no template fields were given to change' };
      return { applied: false, reason: 'The test case already matches the requested values' };
    }

    if (existing.reviewState === ReviewState.AI_DRAFT) {
      // changesToUpdateData only ever returns template fields, and the tool's zod schema has
      // already checked their lengths and the priority enum.
      await this.testCases.update(existing.id, changesToUpdateData(diff) as unknown as UpdateTestCaseDto, user);
      return { applied: true, changed };
    }

    const suggestion = await this.suggestions.createOrReplace(existing.id, changes, rationale, user);
    if (!suggestion) return { applied: false, reason: 'The test case already matches the requested values' };
    return { applied: false, suggestionId: suggestion.suggestionId, changed };
  }
}
