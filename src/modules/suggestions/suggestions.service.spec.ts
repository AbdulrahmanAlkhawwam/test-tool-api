import { Role, SuggestionStatus } from '@prisma/client';
import { SuggestionsService } from './suggestions.service';

const USER = { id: 'u1', email: 'tester@ejad.test', name: 'Tester', role: Role.TESTER };

const CASE_ROW = {
  id: 'case-1',
  name: 'Login',
  description: null,
  preconditions: null,
  steps: '1. Open',
  testData: null,
  expectedResult: null,
  priority: 'MEDIUM',
  notes: null,
};

/**
 * A mocked `tx` that records the order operations actually run in, and a `$queryRaw` that routes
 * to the right canned result by inspecting the SQL text — the same tagged-template shape
 * `accept()`/`createOrReplace()` use for their `FOR UPDATE` locks.
 */
function makeTx(order: string[]) {
  return {
    testCaseSuggestion: {
      findUnique: jest.fn(async () => {
        order.push('suggestion:findUnique(unlocked lookup)');
        return { testCaseId: CASE_ROW.id };
      }),
      update: jest.fn(async () => {
        order.push('suggestion:update(resolve)');
        return { id: 'sugg-1' };
      }),
    },
    testCase: {
      findFirst: jest.fn(async () => {
        order.push('case:findFirst(staleness read)');
        return { ...CASE_ROW };
      }),
      update: jest.fn(async () => {
        order.push('case:update(write)');
        return { id: CASE_ROW.id };
      }),
    },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('"TestCaseSuggestion"')) {
        order.push('suggestion:lock(FOR UPDATE)');
        return [
          {
            status: SuggestionStatus.PENDING,
            testCaseId: CASE_ROW.id,
            changes: { steps: { from: '1. Open', to: '1. Open\n2. Submit' } },
          },
        ];
      }
      if (sql.includes('"TestCase"')) {
        order.push('case:lock(FOR UPDATE)');
        return [{ id: CASE_ROW.id }];
      }
      throw new Error(`unexpected $queryRaw in test: ${sql}`);
    }),
  };
}

function makeService() {
  const order: string[] = [];
  const tx = makeTx(order);
  const prisma = {
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    testCase: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: CASE_ROW.id }) },
  };
  const service = new SuggestionsService(prisma as never);
  return { service, order };
}

describe('SuggestionsService.accept — lock order (ABBA deadlock guard)', () => {
  it('locks the TestCase row before the TestCaseSuggestion row, and only reads/writes the case after both locks are held', async () => {
    // createOrReplace() locks TestCase then TestCaseSuggestion (see its own comment). accept()
    // must lock in the same order — case first — or a tester's accept() and the AI's
    // createOrReplace() can deadlock under Postgres (40P01) by locking the same two resources in
    // opposite order. This test pins that order with a mocked tx, so a regression is caught
    // deterministically instead of depending on winning a real-database race.
    const { service, order } = makeService();

    await service.accept('sugg-1', USER);

    const caseLock = order.indexOf('case:lock(FOR UPDATE)');
    const suggestionLock = order.indexOf('suggestion:lock(FOR UPDATE)');
    const stalenessRead = order.indexOf('case:findFirst(staleness read)');
    const write = order.indexOf('case:update(write)');

    expect(caseLock).toBeGreaterThanOrEqual(0);
    // The actual regression this guards: locking the suggestion before the case deadlocks with
    // createOrReplace()'s case-then-suggestion order.
    expect(suggestionLock).toBeGreaterThan(caseLock);
    // The staleness read must happen only once the case row is already locked (closes the
    // "PATCH commits between the staleness check and the write" bug): it can no longer run
    // before the lock is acquired.
    expect(stalenessRead).toBeGreaterThan(caseLock);
    expect(write).toBeGreaterThan(stalenessRead);
  });
});
