import { ReviewState, Role } from '@prisma/client';
import { CreateCaseInput, McpWriteService, repairDerivedModuleCode, validateCase } from './mcp-write.service';

const USER = { id: 'u1', email: 'ai@ejad.test', name: 'AI', role: Role.TESTER };

function makeService() {
  const prisma = { testCase: { findFirst: jest.fn(), updateMany: jest.fn() } };
  const projects = { getByKey: jest.fn() };
  const modules = { create: jest.fn() };
  const testCases = { create: jest.fn(), update: jest.fn() };
  const suggestions = { createOrReplace: jest.fn() };
  const service = new McpWriteService(prisma as never, projects as never, modules as never, testCases as never, suggestions as never);
  return { service, prisma, projects, modules, testCases, suggestions };
}

describe('validateCase — pure per-item limits', () => {
  const base: CreateCaseInput = { moduleCode: 'AUTH', name: 'Login' };

  it('accepts a minimal valid case', () => {
    expect(validateCase(base)).toBeNull();
  });

  it('rejects an empty or over-long name', () => {
    expect(validateCase({ ...base, name: '' })).toBe('name must be between 1 and 300 characters');
    expect(validateCase({ ...base, name: '   ' })).toBe('name must be between 1 and 300 characters');
    expect(validateCase({ ...base, name: 'x'.repeat(301) })).toBe('name must be between 1 and 300 characters');
    expect(validateCase({ ...base, name: 'x'.repeat(300) })).toBeNull();
  });

  it('accepts exactly 10,000 characters of steps and rejects 10,001', () => {
    expect(validateCase({ ...base, steps: 'x'.repeat(10_000) })).toBeNull();
    expect(validateCase({ ...base, steps: 'x'.repeat(10_001) })).toBe('steps must be at most 10000 characters');
  });

  it('accepts exactly 5,000 characters for the other text fields and rejects 5,001', () => {
    for (const field of ['description', 'preconditions', 'testData', 'expectedResult', 'notes'] as const) {
      expect(validateCase({ ...base, [field]: 'x'.repeat(5000) })).toBeNull();
      expect(validateCase({ ...base, [field]: 'x'.repeat(5001) })).toBe(`${field} must be at most 5000 characters`);
    }
  });
});

describe('repairDerivedModuleCode — derived module codes always satisfy the letter-first rule', () => {
  it('leaves an already-valid derived code untouched', () => {
    expect(repairDerivedModuleCode('FP')).toBe('FP');
  });

  it('prefixes a letter when the derived code starts with a digit', () => {
    // "2FA Login" -> two words -> first letters "2" + "L" -> "2L"
    expect(repairDerivedModuleCode('2L')).toBe('M2L');
    // "2 Factor Auth" -> three words -> first letters "2" + "F" + "A" -> "2FA"
    expect(repairDerivedModuleCode('2FA')).toBe('M2FA');
    // "123 Checkout" -> two words -> first letters "1" + "C" -> "1C"
    expect(repairDerivedModuleCode('1C')).toBe('M1C');
  });

  it('always returns a string MODULE_CODE_RE accepts', () => {
    for (const input of ['2L', '2FA', '1C', 'FP', '999', '']) {
      expect(repairDerivedModuleCode(input)).toMatch(/^[A-Z][A-Z0-9]{0,9}$/);
    }
  });
});

describe('McpWriteService.createModule — derives, repairs and never rejects its own code', () => {
  it('repairs "2FA Login" into a valid, non-empty code instead of rejecting it', async () => {
    const { service, projects, modules } = makeService();
    projects.getByKey.mockResolvedValueOnce({ id: 'p1', key: 'NINJA', modules: [] });
    modules.create.mockImplementationOnce((_projectId: string, dto: { name: string; code: string }) =>
      Promise.resolve({ name: dto.name, code: dto.code }),
    );

    const result = await service.createModule('NINJA', '2FA Login', undefined);

    expect(result.code).toMatch(/^[A-Z][A-Z0-9]{0,9}$/);
    expect(modules.create).toHaveBeenCalledWith('p1', { name: '2FA Login', code: result.code });
  });

  it('repairs "2 Factor Auth" and "123 Checkout" the same way', async () => {
    for (const [name, expected] of [
      ['2 Factor Auth', 'M2FA'],
      ['123 Checkout', 'M1C'],
    ] as const) {
      const { service, projects, modules } = makeService();
      projects.getByKey.mockResolvedValueOnce({ id: 'p1', key: 'NINJA', modules: [] });
      modules.create.mockImplementationOnce((_projectId: string, dto: { name: string; code: string }) =>
        Promise.resolve({ name: dto.name, code: dto.code }),
      );

      const result = await service.createModule('NINJA', name, undefined);
      expect(result.code).toBe(expected);
    }
  });

  it('still rejects a caller-supplied code that fails the regex, without repairing it', async () => {
    const { service, projects } = makeService();
    projects.getByKey.mockResolvedValueOnce({ id: 'p1', key: 'NINJA', modules: [] });

    await expect(service.createModule('NINJA', 'Nope', '9bad')).rejects.toMatchObject({
      message: 'code must be 1–10 uppercase letters/digits, starting with a letter',
    });
  });
});

describe('McpWriteService.createTestCases — batch errors never leak raw internals', () => {
  it('turns an unexpected non-HttpException error into the generic tool-error message', async () => {
    const { service, projects, testCases } = makeService();
    projects.getByKey.mockResolvedValueOnce({ id: 'p1', key: 'NINJA', modules: [{ id: 'm1', code: 'AUTH' }] });
    testCases.create.mockRejectedValueOnce(
      new Error('invalid input syntax for type uuid: "x" at TestCasesService.create (/srv/app/dist/src/modules/test-cases/test-cases.service.js:42:19)'),
    );

    const batch = await service.createTestCases('NINJA', [{ moduleCode: 'AUTH', name: 'Case 1' }], USER as never);

    expect(batch).toMatchObject({ created: 0, failed: 1 });
    expect(batch.results[0]).toEqual({ ok: false, error: 'The request could not be completed' });
    // The raw message (with the file path) must not appear anywhere in the result.
    expect(JSON.stringify(batch)).not.toContain('test-cases.service.js');
  });
});

describe('McpWriteService.updateTestCase — reason when nothing changes', () => {
  const EXISTING = {
    id: 'c1',
    reviewState: ReviewState.APPROVED,
    name: 'Login',
    description: null,
    preconditions: null,
    steps: '1. Open',
    testData: null,
    expectedResult: null,
    priority: 'MEDIUM',
    notes: null,
  };

  it('gives a distinct reason when every requested key was stripped as a non-template field', async () => {
    const { service, projects, prisma } = makeService();
    projects.getByKey.mockResolvedValueOnce({ id: 'p1', key: 'NINJA', modules: [] });
    prisma.testCase.findFirst.mockResolvedValueOnce(EXISTING);

    // Simulates what reaches the service after zod strips code/reviewState: an empty object.
    const result = await service.updateTestCase('NINJA', 'TC-AUTH-001', {}, undefined, USER as never);

    expect(result).toEqual({ applied: false, reason: 'no template fields were given to change' });
  });

  it('keeps the original reason when a real template field was given but already matches', async () => {
    const { service, projects, prisma } = makeService();
    projects.getByKey.mockResolvedValueOnce({ id: 'p1', key: 'NINJA', modules: [] });
    prisma.testCase.findFirst.mockResolvedValueOnce(EXISTING);

    const result = await service.updateTestCase('NINJA', 'TC-AUTH-001', { steps: '1. Open' }, undefined, USER as never);

    expect(result).toEqual({ applied: false, reason: 'The test case already matches the requested values' });
  });
});

describe('McpWriteService.updateTestCase — cannot race an Approve into a direct write', () => {
  // Read as AI_DRAFT: this is what lets the buggy code below take the "apply directly" branch.
  const DRAFT_AS_READ = {
    id: 'c1',
    reviewState: ReviewState.AI_DRAFT,
    name: 'Login',
    description: null,
    preconditions: null,
    steps: '1. Open',
    testData: null,
    expectedResult: null,
    priority: 'MEDIUM',
    notes: null,
  };

  it('falls through to a suggestion instead of writing directly when the case was approved between the read and the write', async () => {
    const { service, projects, prisma, testCases, suggestions } = makeService();
    projects.getByKey.mockResolvedValueOnce({ id: 'p1', key: 'NINJA', modules: [] });
    prisma.testCase.findFirst.mockResolvedValueOnce(DRAFT_AS_READ);
    // Simulates a tester's Approve landing between the read above and the write below: the
    // reviewState-guarded UPDATE matches nothing because the row is no longer AI_DRAFT.
    prisma.testCase.updateMany.mockResolvedValueOnce({ count: 0 });
    suggestions.createOrReplace.mockResolvedValueOnce({
      suggestionId: 's1',
      changes: { steps: { from: '1. Open', to: '1. Open the login page' } },
    });

    const result = await service.updateTestCase('NINJA', 'TC-AUTH-001', { steps: '1. Open the login page' }, undefined, USER as never);

    // The guarded UPDATE was attempted with reviewState still pinned to AI_DRAFT ...
    expect(prisma.testCase.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', reviewState: ReviewState.AI_DRAFT, deletedAt: null },
      data: expect.objectContaining({ steps: '1. Open the login page', updatedById: USER.id }),
    });
    // ... it must never fall back to an unconditional write that ignores the race ...
    expect(testCases.update).not.toHaveBeenCalled();
    // ... and the edit must land as a suggestion instead of being silently applied.
    expect(suggestions.createOrReplace).toHaveBeenCalledWith(
      'c1',
      { steps: '1. Open the login page' },
      undefined,
      USER,
    );
    expect(result).toEqual({ applied: false, suggestionId: 's1', changed: ['steps'] });
  });

  it('applies directly when the guarded UPDATE still matches (no race)', async () => {
    const { service, projects, prisma, suggestions } = makeService();
    projects.getByKey.mockResolvedValueOnce({ id: 'p1', key: 'NINJA', modules: [] });
    prisma.testCase.findFirst.mockResolvedValueOnce(DRAFT_AS_READ);
    prisma.testCase.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await service.updateTestCase('NINJA', 'TC-AUTH-001', { steps: '1. Open the login page' }, undefined, USER as never);

    expect(result).toEqual({ applied: true, changed: ['steps'] });
    expect(suggestions.createOrReplace).not.toHaveBeenCalled();
  });
});
