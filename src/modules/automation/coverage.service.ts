import { Injectable, NotFoundException } from '@nestjs/common';
import { mapWithConcurrency } from '../../common/concurrency';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { GitlabApiService } from '../gitlab/gitlab-api.service';
import { GitlabConnectionService } from '../gitlab/gitlab-connection.service';
import { AutomationService } from './automation.service';
import { extractCaseTags } from './case-tags';
import { computeCoverage, FileTags } from './coverage';
import { CoverageCache, FileScan } from './coverage-cache';

/** At most this many .ts/.js files under testsPath are scanned for @TC tags. */
const MAX_SCANNED_FILES = 500;
/**
 * Files at or under this size are downloaded and scanned; larger ones are skipped (and reported
 * in `skippedFiles`) without ever pulling their content into memory. A HEAD request tells us the
 * size first, so a multi-megabyte fixture never gets downloaded just to find out it's too big.
 */
const MAX_SCANNED_FILE_BYTES = 1024 * 1024;
/** At most this many HEAD/GET calls to GitLab run at once while scanning a project's test files. */
const MAX_CONCURRENT_SCANS = 6;

type ScanResult = FileTags | { path: string; skipped: true };

@Injectable()
export class CoverageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly automation: AutomationService,
    private readonly gitlab: GitlabConnectionService,
    private readonly api: GitlabApiService,
    private readonly cache: CoverageCache,
  ) {}

  async coverage(projectId: string, ref: string | undefined, user: AuthUser) {
    const project = await this.automation.requireLinked(projectId);
    const branchName = ref ?? project.defaultBranch;
    const pid = project.gitlabProjectId;

    const { commitId, files, skippedFiles } = await this.gitlab.withToken(user.id, async (token) => {
      const branch = await this.api.getBranch(token, pid, branchName);
      if (!branch) throw new NotFoundException(`Branch "${branchName}" was not found`);
      const key = `${pid}:${branch.commitId}:${project.testsPath}`;
      const cached = this.cache.get(key);
      if (cached) return { commitId: branch.commitId, ...cached };

      // Read by commit SHA so the whole scan sees one consistent snapshot.
      const blobs = (await this.api.listTree(token, pid, branch.commitId, project.testsPath))
        .filter((entry) => entry.type === 'blob' && /\.(ts|js)$/.test(entry.path))
        .slice(0, MAX_SCANNED_FILES);

      const scan = await this.scanFiles(token, pid, branch.commitId, blobs.map((b) => b.path));
      this.cache.set(key, scan);
      return { commitId: branch.commitId, ...scan };
    });

    const cases = await this.prisma.testCase.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true, module: { select: { code: true, name: true } } },
    });
    return { ref: branchName, commitId, ...computeCoverage(files, cases), skippedFiles };
  }

  private async scanFiles(token: string, pid: number, commitSha: string, paths: string[]): Promise<FileScan> {
    const results = await mapWithConcurrency(paths, MAX_CONCURRENT_SCANS, async (path): Promise<ScanResult> => {
      // Learn the size before downloading anything: a huge fixture should never be pulled into
      // memory just to be scanned for @TC tags.
      const head = await this.api.headFile(token, pid, commitSha, path);
      // A file missing at either point (deleted between the tree listing and the HEAD, or between
      // the HEAD and this GET) still belongs in the report as an untagged file rather than
      // silently vanishing from it: `codes: []` covers both.
      if (!head) return { path, codes: [] };
      if (head.size > MAX_SCANNED_FILE_BYTES) return { path, skipped: true };
      const file = await this.api.getFile(token, pid, commitSha, path);
      return { path, codes: file ? extractCaseTags(file.content) : [] };
    });

    const scanned: FileTags[] = [];
    const skippedFiles: string[] = [];
    // `results` is already in `paths` order (mapWithConcurrency preserves input order); the loop
    // below just partitions it, so `scanned`'s order stays deterministic regardless of which
    // HEAD/GET call actually finished first.
    for (const result of results) {
      if ('skipped' in result) skippedFiles.push(result.path);
      else scanned.push(result);
    }
    return { files: scanned, skippedFiles: skippedFiles.sort() };
  }
}
