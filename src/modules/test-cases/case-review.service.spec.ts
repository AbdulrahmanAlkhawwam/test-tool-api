import { ReviewState, Role } from '@prisma/client';
import { CaseReviewService } from './case-review.service';

const USER = { id: 'u1', email: 'tester@ejad.test', name: 'Tester', role: Role.TESTER };

function makeService() {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    testCase: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
  };
  const service = new CaseReviewService(prisma as never);
  return { service, prisma };
}

describe('CaseReviewService.approve — guarded write', () => {
  it('approves a draft normally', async () => {
    const { service, prisma } = makeService();
    prisma.testCase.findFirst.mockResolvedValueOnce({ id: 'c1', reviewState: ReviewState.AI_DRAFT });
    prisma.testCase.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.testCase.findUniqueOrThrow.mockResolvedValueOnce({ id: 'c1', reviewState: ReviewState.APPROVED });

    const result = await service.approve('c1', USER);

    expect(result).toEqual({ id: 'c1', reviewState: ReviewState.APPROVED });
    expect(prisma.testCase.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', reviewState: ReviewState.AI_DRAFT, deletedAt: null },
      data: expect.objectContaining({ reviewState: ReviewState.APPROVED, approvedById: 'u1' }),
    });
  });

  it('rejects immediately, without attempting a write, when the initial read already shows APPROVED', async () => {
    const { service, prisma } = makeService();
    prisma.testCase.findFirst.mockResolvedValueOnce({ id: 'c1', reviewState: ReviewState.APPROVED });

    await expect(service.approve('c1', USER)).rejects.toMatchObject({ message: 'Test case is already approved' });
    expect(prisma.testCase.updateMany).not.toHaveBeenCalled();
  });

  it('rejects immediately when the initial read finds no active case', async () => {
    const { service, prisma } = makeService();
    prisma.testCase.findFirst.mockResolvedValueOnce(null);

    await expect(service.approve('c1', USER)).rejects.toMatchObject({ message: 'Test case not found' });
    expect(prisma.testCase.updateMany).not.toHaveBeenCalled();
  });

  it('answers 404, not 200, when the case is soft-deleted between the read and the guarded write', async () => {
    const { service, prisma } = makeService();
    // The read sees a live draft...
    prisma.testCase.findFirst.mockResolvedValueOnce({ id: 'c1', reviewState: ReviewState.AI_DRAFT });
    // ...but by the time the guarded update runs, someone else has soft-deleted it, so the
    // deletedAt: null guard means it writes nothing.
    prisma.testCase.updateMany.mockResolvedValueOnce({ count: 0 });
    // The re-check after the failed write sees the row as gone.
    prisma.testCase.findFirst.mockResolvedValueOnce({ id: 'c1', deletedAt: new Date() });

    await expect(service.approve('c1', USER)).rejects.toMatchObject({ status: 404, message: 'Test case not found' });
    expect(prisma.testCase.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('answers 409, not 200, when the case is approved by someone else between the read and the guarded write', async () => {
    const { service, prisma } = makeService();
    prisma.testCase.findFirst.mockResolvedValueOnce({ id: 'c1', reviewState: ReviewState.AI_DRAFT });
    prisma.testCase.updateMany.mockResolvedValueOnce({ count: 0 });
    // Re-check: the row still exists, is not deleted — the guard failed because someone else
    // already flipped it to APPROVED in between.
    prisma.testCase.findFirst.mockResolvedValueOnce({ id: 'c1', deletedAt: null });

    await expect(service.approve('c1', USER)).rejects.toMatchObject({ status: 409, message: 'Test case is already approved' });
    expect(prisma.testCase.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe('CaseReviewService.approveMany — guarded write', () => {
  it('reports only the ids the guarded write actually approved, in the caller order', async () => {
    const { service, prisma } = makeService();
    prisma.testCase.findMany.mockResolvedValueOnce([
      { id: 'a', projectId: 'p1', reviewState: ReviewState.AI_DRAFT, deletedAt: null },
      { id: 'b', projectId: 'p1', reviewState: ReviewState.APPROVED, deletedAt: null },
      { id: 'c', projectId: 'p1', reviewState: ReviewState.AI_DRAFT, deletedAt: null },
    ]);
    // The RETURNING rows from the guarded UPDATE: only 'a' actually got written, even though
    // both 'a' and 'c' were candidates — simulating 'c' being soft-deleted or approved by someone
    // else in the window between the classification read and this write.
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'a' }]);
    // The follow-up re-check for the raced id 'c'.
    prisma.testCase.findMany.mockResolvedValueOnce([{ id: 'c', deletedAt: null }]);

    const result = await service.approveMany(['a', 'b', 'c'], USER);

    expect(result).toEqual({
      approved: ['a'],
      failed: [
        { id: 'b', message: 'Test case is already approved' },
        { id: 'c', message: 'Test case is already approved' },
      ],
    });
  });

  it('reports a raced id that turns out soft-deleted as not found', async () => {
    const { service, prisma } = makeService();
    prisma.testCase.findMany.mockResolvedValueOnce([
      { id: 'a', projectId: 'p1', reviewState: ReviewState.AI_DRAFT, deletedAt: null },
    ]);
    prisma.$queryRaw.mockResolvedValueOnce([]); // nothing written
    prisma.testCase.findMany.mockResolvedValueOnce([{ id: 'a', deletedAt: new Date() }]);

    const result = await service.approveMany(['a'], USER);

    expect(result).toEqual({ approved: [], failed: [{ id: 'a', message: 'Test case not found' }] });
  });

  it('does not touch the database write path when every id fails the initial classification', async () => {
    const { service, prisma } = makeService();
    prisma.testCase.findMany.mockResolvedValueOnce([{ id: 'a', projectId: 'p1', reviewState: ReviewState.APPROVED, deletedAt: null }]);

    const result = await service.approveMany(['a'], USER);

    expect(result).toEqual({ approved: [], failed: [{ id: 'a', message: 'Test case is already approved' }] });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
