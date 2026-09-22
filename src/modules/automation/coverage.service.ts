import { Injectable, NotFoundException } from '@nestjs/common';
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
    const scanned: FileTags[] = [];
    const skippedFiles: string[] = [];
    for (const path of paths) {
      // Learn the size before downloading anything: a huge fixture should never be pulled into
      // memory just to be scanned for @TC tags.
      const head = await this.api.headFile(token, pid, commitSha, path);
      if (!head) continue; // Deleted between the tree listing and this read.
      if (head.size > MAX_SCANNED_FILE_BYTES) {
        skippedFiles.push(path);
        continue;
      }
      const file = await this.api.getFile(token, pid, commitSha, path);
      scanned.push({ path, codes: file ? extractCaseTags(file.content) : [] });
    }
    return { files: scanned, skippedFiles: skippedFiles.sort() };
  }
}
