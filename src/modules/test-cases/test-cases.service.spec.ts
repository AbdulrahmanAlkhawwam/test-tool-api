import { Priority, ResultStatus } from '@prisma/client';
import { TestCasesService } from './test-cases.service';
import { ListTestCasesQuery } from './dto/list-test-cases.query';

function makeService() {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    testCase: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const projects = { requireProject: jest.fn().mockResolvedValue({ id: 'p1' }) };
  const service = new TestCasesService(prisma as never, projects as never);
  return { service, prisma };
}

function query(overrides: Partial<ListTestCasesQuery> = {}): ListTestCasesQuery {
  return Object.assign(new ListTestCasesQuery(), { page: 1, pageSize: 50, ...overrides });
}

describe('TestCasesService.list — where-clause construction', () => {
  /**
   * Carry-over regression (Task 7 review): the status filter layers its APPROVED exclusion onto
   * `where.AND` with a spread (`where.AND = [...existingAnd, ...]`) instead of a plain assignment,
   * so a future filter that also needs `where.AND` cannot have its condition silently dropped.
   * This pins that the other independent filters (moduleId, priority, the q search) stay at the
   * top level of `where` — only the status-driven APPROVED exclusion goes into `AND` — so a
   * regression that collapsed the whole `where` into the AND-assignment, or that overwrote rather
   * than appended, would break this test the moment a second AND-needing filter is introduced.
   */
  it('appends the APPROVED exclusion onto where.AND instead of overwriting the rest of the filter', async () => {
    const { service, prisma } = makeService();

    await service.list('p1', query({ moduleId: 'm1', priority: Priority.HIGH, q: 'login', status: ResultStatus.FAILED }));

    const call = prisma.testCase.findMany.mock.calls[0][0];
    expect(call.where).toMatchObject({
      projectId: 'p1',
      deletedAt: null,
      moduleId: 'm1',
      priority: Priority.HIGH,
      OR: [
        { name: { contains: 'login', mode: 'insensitive' } },
        { code: { contains: 'login', mode: 'insensitive' } },
        { description: { contains: 'login', mode: 'insensitive' } },
      ],
    });
    // The status filter is expressed as an appended AND array, not folded into `where.reviewState`.
    expect(call.where.AND).toEqual([{ reviewState: 'APPROVED' }]);
    expect(call.where.reviewState).toBeUndefined();
    // count() must see the exact same where the findMany call used.
    expect(prisma.testCase.count.mock.calls[0][0].where).toEqual(call.where);
  });

  it('does not touch where.AND when no status filter is given', async () => {
    const { service, prisma } = makeService();

    await service.list('p1', query({ moduleId: 'm1' }));

    const call = prisma.testCase.findMany.mock.calls[0][0];
    expect(call.where.AND).toBeUndefined();
  });
});
