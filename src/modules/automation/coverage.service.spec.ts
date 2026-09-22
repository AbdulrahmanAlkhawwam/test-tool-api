import { AuthUser } from '../../common/types/auth-user';
import { AutomationService, LinkedProject } from './automation.service';
import { CoverageCache } from './coverage-cache';
import { CoverageService } from './coverage.service';

const USER = { id: 'u1' } as AuthUser;
const PROJECT = { id: 'p1', gitlabProjectId: 7, testsPath: 'e2e', defaultBranch: 'main' } as LinkedProject;

describe('CoverageService', () => {
  const prisma = { testCase: { findMany: jest.fn().mockResolvedValue([]) } };
  const automation = { requireLinked: jest.fn().mockResolvedValue(PROJECT) } as unknown as AutomationService;
  const gitlab = { withToken: jest.fn((_userId: string, fn: (token: string) => unknown) => fn('tok')) };

  beforeEach(() => {
    prisma.testCase.findMany.mockClear();
  });

  function makeService(api: {
    getBranch: jest.Mock;
    listTree: jest.Mock;
    headFile: jest.Mock;
    getFile: jest.Mock;
  }): CoverageService {
    return new CoverageService(
      prisma as never,
      automation,
      gitlab as never,
      api as never,
      new CoverageCache(),
    );
  }

  it('keeps a file whose HEAD 404s (deleted after the tree listing) in the report, untagged', async () => {
    const paths = ['e2e/a.spec.ts', 'e2e/b.spec.ts', 'e2e/c.spec.ts'];
    const api = {
      getBranch: jest.fn().mockResolvedValue({ commitId: 'sha1' }),
      listTree: jest.fn().mockResolvedValue(paths.map((path) => ({ path, name: path, type: 'blob' as const }))),
      headFile: jest.fn(async (_t, _p, _c, path: string) =>
        path === 'e2e/b.spec.ts' ? null : { size: 10, lastCommitId: 'sha1', blobId: 'blob' },
      ),
      getFile: jest.fn(async (_t, _p, _c, path: string) => ({ path, size: 10, content: `x @TC-X-00${path.length}`, lastCommitId: 'sha1', isValidUtf8: true })),
    };
    const service = makeService(api);

    const result = await service.coverage('p1', undefined, USER);

    expect(result.files.map((f) => f.path)).toEqual(paths);
    expect(result.files.find((f) => f.path === 'e2e/b.spec.ts')).toEqual({ path: 'e2e/b.spec.ts', cases: [], unknownCodes: [] });
    // The vanished file only ever got a HEAD attempt, never a GET.
    expect(api.getFile).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 'e2e/b.spec.ts');
  });

  it('keeps a file whose GET 404s (deleted between the HEAD and the GET) in the report, untagged', async () => {
    const paths = ['e2e/a.spec.ts'];
    const api = {
      getBranch: jest.fn().mockResolvedValue({ commitId: 'sha1' }),
      listTree: jest.fn().mockResolvedValue(paths.map((path) => ({ path, name: path, type: 'blob' as const }))),
      headFile: jest.fn().mockResolvedValue({ size: 10, lastCommitId: 'sha1', blobId: 'blob' }),
      getFile: jest.fn().mockResolvedValue(null),
    };
    const service = makeService(api);

    const result = await service.coverage('p1', undefined, USER);

    expect(result.files).toEqual([{ path: 'e2e/a.spec.ts', cases: [], unknownCodes: [] }]);
  });

  it('scans files with no more than 6 HEAD/GET calls in flight at once', async () => {
    const paths = Array.from({ length: 15 }, (_, i) => `e2e/f${i}.spec.ts`);
    let inFlight = 0;
    let maxInFlight = 0;
    const track = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
    };
    const api = {
      getBranch: jest.fn().mockResolvedValue({ commitId: 'sha1' }),
      listTree: jest.fn().mockResolvedValue(paths.map((path) => ({ path, name: path, type: 'blob' as const }))),
      headFile: jest.fn(async () => {
        await track();
        return { size: 10, lastCommitId: 'sha1', blobId: 'blob' };
      }),
      getFile: jest.fn(async (_t, _p, _c, path: string) => ({ path, size: 10, content: 'x', lastCommitId: 'sha1', isValidUtf8: true })),
    };
    const service = makeService(api);

    await service.coverage('p1', undefined, USER);

    expect(maxInFlight).toBeLessThanOrEqual(6);
    expect(maxInFlight).toBe(6);
  });
});
