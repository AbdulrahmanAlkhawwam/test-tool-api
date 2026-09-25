import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma, SuggestionStatus } from '@prisma/client';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { CASE_INCLUDE, USER_REF } from '../test-cases/case-include';
import { UpdateTestCaseDto } from '../test-cases/dto/update-test-case.dto';
import {
  buildSuggestionChanges,
  changesToUpdateData,
  isSuggestionStale,
  parseSuggestionChanges,
  ProposedFields,
  SuggestionChanges,
} from './suggestion-diff';

/** Spec §6, verbatim (note the en dash). */
const STALE = 'The test case changed since this suggestion – review it again';
const RESOLVED = 'This suggestion has already been resolved';
const NOT_FOUND = 'Test case not found';
const SUGGESTION_NOT_FOUND = 'Suggestion not found';

/** The case fields a suggestion may read or write. */
const CASE_FIELDS = {
  id: true,
  name: true,
  description: true,
  preconditions: true,
  steps: true,
  testData: true,
  expectedResult: true,
  priority: true,
  notes: true,
} satisfies Prisma.TestCaseSelect;

export interface PendingSuggestion {
  id: string;
  testCaseId: string;
  status: SuggestionStatus;
  changes: SuggestionChanges;
  rationale: string | null;
  createdAt: Date;
  createdBy: { id: string; name: string };
}

@Injectable()
export class SuggestionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stores the AI's proposal for an approved case. Only one pending suggestion per case exists
   * (spec §6), so the previous one is deleted rather than marked REJECTED: nobody rejected it,
   * it was simply superseded, and keeping it would muddy the accept/reject audit trail.
   * Returns null when the proposal changes nothing.
   */
  async createOrReplace(
    testCaseId: string,
    proposed: ProposedFields,
    rationale: string | undefined,
    user: AuthUser,
  ): Promise<{ suggestionId: string; changes: SuggestionChanges } | null> {
    return this.prisma.$transaction(async (tx) => {
      // Lock the test case row first so two concurrent proposals for the same case serialize.
      // There is no unique index tying a case to its (at most one) pending suggestion, so without
      // this lock two overlapping calls can each run deleteMany-then-create, both see zero pending
      // rows at the time they check, and both insert — leaving two "pending" suggestions on one
      // case. Everything below runs sequentially (no Promise.all): that would break the
      // transaction's single pinned pg client.
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "TestCase" WHERE id = ${testCaseId} AND "deletedAt" IS NULL FOR UPDATE`;
      if (!locked) throw new NotFoundException(NOT_FOUND);

      const current = await tx.testCase.findFirst({ where: { id: testCaseId }, select: CASE_FIELDS });
      if (!current) throw new NotFoundException(NOT_FOUND);
      const changes = buildSuggestionChanges(current, proposed);
      if (!Object.keys(changes).length) return null;

      await tx.testCaseSuggestion.deleteMany({ where: { testCaseId, status: SuggestionStatus.PENDING } });
      const created = await tx.testCaseSuggestion.create({
        data: { testCaseId, changes: changes as Prisma.InputJsonValue, rationale: rationale ?? null, createdById: user.id },
        select: { id: true },
      });
      return { suggestionId: created.id, changes };
    });
  }

  async pendingFor(testCaseId: string): Promise<PendingSuggestion | null> {
    const exists = await this.prisma.testCase.findFirst({ where: { id: testCaseId, deletedAt: null }, select: { id: true } });
    if (!exists) throw new NotFoundException(NOT_FOUND);
    const row = await this.prisma.testCaseSuggestion.findFirst({
      where: { testCaseId, status: SuggestionStatus.PENDING },
      orderBy: { createdAt: 'desc' },
      select: { id: true, testCaseId: true, status: true, changes: true, rationale: true, createdAt: true, createdBy: USER_REF },
    });
    if (!row) return null;
    return { ...row, changes: parseSuggestionChanges(row.changes) };
  }

  async accept(id: string, user: AuthUser) {
    const caseId = await this.prisma.$transaction(async (tx) => {
      // Lock the suggestion row first so two testers cannot both apply it. Everything inside runs
      // sequentially: a Promise.all here would break the transaction's single pinned pg client.
      const [locked] = await tx.$queryRaw<{ status: SuggestionStatus; testCaseId: string; changes: unknown }[]>`
        SELECT status, "testCaseId", changes FROM "TestCaseSuggestion" WHERE id = ${id} FOR UPDATE`;
      if (!locked) throw new NotFoundException(SUGGESTION_NOT_FOUND);
      if (locked.status !== SuggestionStatus.PENDING) throw new ConflictException(RESOLVED);

      const current = await tx.testCase.findFirst({ where: { id: locked.testCaseId, deletedAt: null }, select: CASE_FIELDS });
      if (!current) throw new NotFoundException(NOT_FOUND);

      const changes = parseSuggestionChanges(locked.changes);
      if (isSuggestionStale(changes, current)) throw new ConflictException(STALE);

      // `name` and `priority` can only appear here as non-null strings — buildSuggestionChanges
      // never lets them through the accept path as null (see NULLABLE in suggestion-diff.ts) —
      // but changesToUpdateData's return type is shared with every other (nullable) field.
      const updateData = changesToUpdateData(changes);
      // Spec §6: accept "validates like a normal edit". The suggestion's `changes` are stored as
      // free-form JSON (they may have been written by an older version, or hand-edited), so this
      // is the only place that ever checks their lengths and enum values before they reach Prisma.
      await this.validateUpdate(updateData);
      await tx.testCase.update({
        where: { id: current.id },
        data: { ...(updateData as Prisma.TestCaseUncheckedUpdateInput), updatedById: user.id },
        select: { id: true },
      });
      await tx.testCaseSuggestion.update({
        where: { id },
        data: { status: SuggestionStatus.ACCEPTED, resolvedById: user.id, resolvedAt: new Date() },
        select: { id: true },
      });
      return current.id;
    });
    // Read the relations back outside the transaction (an include inside would run the relation
    // queries in parallel on the transaction's pinned client).
    return this.prisma.testCase.findUniqueOrThrow({ where: { id: caseId }, include: CASE_INCLUDE });
  }

  /**
   * Runs the same class-validator checks `PATCH /test-cases/:id` gets from the global
   * `ValidationPipe` (`UpdateTestCaseDto`), but by hand: this call never goes through an HTTP
   * pipe. On failure it throws the same shape `ValidationPipe` would (`message` is the array of
   * constraint messages), so `HttpExceptionFilter` turns it into the standard
   * `{ statusCode: 400, error: 'Bad Request', message: 'Validation failed', details }` body.
   */
  private async validateUpdate(data: Partial<Record<string, string | null>>): Promise<void> {
    const dto = plainToInstance(UpdateTestCaseDto, data);
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length) {
      const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
      throw new BadRequestException(messages);
    }
  }

  async reject(id: string, user: AuthUser): Promise<{ id: string; status: 'REJECTED' }> {
    const { count } = await this.prisma.testCaseSuggestion.updateMany({
      where: { id, status: SuggestionStatus.PENDING },
      data: { status: SuggestionStatus.REJECTED, resolvedById: user.id, resolvedAt: new Date() },
    });
    if (count === 1) return { id, status: 'REJECTED' };
    const exists = await this.prisma.testCaseSuggestion.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException(SUGGESTION_NOT_FOUND);
    throw new ConflictException(RESOLVED);
  }
}
