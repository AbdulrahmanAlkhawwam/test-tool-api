import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { Project } from '@prisma/client';
import { AuthUser } from '../../common/types/auth-user';
import { GitlabApiService } from '../gitlab/gitlab-api.service';
import { GitlabConnectionService } from '../gitlab/gitlab-connection.service';
import { GitlabHttpError } from '../gitlab/gitlab-http-error';
import { GitlabCommit, GitlabMergeRequest } from '../gitlab/gitlab.types';
import { ProjectsService } from '../projects/projects.service';
import { extractCaseTags } from './case-tags';
import { FileQueryDto } from './dto/automation-query.dto';
import { SaveFileDto } from './dto/save-file.dto';
import { buildMrDescription, mergeRequestTitle } from './mr-description';
import { resolveEditablePath, resolveInTestsPath, workBranchName, workBranchPrefix } from './paths';

export const MAX_EDITABLE_BYTES = 1024 * 1024;
/** Above this, the file's content is never downloaded: the tool can't render it at all. */
export const MAX_VIEWABLE_BYTES = 5 * 1024 * 1024;
export const STALE_FILE_MESSAGE = 'This file changed on the branch – reload it before saving';
export const FILE_EXISTS_MESSAGE = 'A file with this path already exists – open it before saving';
export const NOT_UTF8_MESSAGE = "This file isn't UTF-8 text and can't be edited here";

export type LinkedProject = Project & {
  gitlabProjectId: number;
  gitlabPath: string;
  gitlabWebUrl: string;
  defaultBranch: string;
  testsPath: string;
  playwrightConfigPath: string;
};

export interface MergeRequestRef {
  iid: number;
  webUrl: string;
  state: GitlabMergeRequest['state'];
}

export interface SaveFileResult {
  branch: string;
  commitId: string;
  /** Null when the commit landed but opening/updating the merge request failed (save still succeeded). */
  mergeRequest: MergeRequestRef | null;
}

const toRef = (mr: GitlabMergeRequest): MergeRequestRef => ({ iid: mr.iid, webUrl: mr.webUrl, state: mr.state });

@Injectable()
export class AutomationService {
  private readonly logger = new Logger(AutomationService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly gitlab: GitlabConnectionService,
    private readonly api: GitlabApiService,
  ) {}

  async requireLinked(projectId: string): Promise<LinkedProject> {
    const project = await this.projects.requireProject(projectId);
    const { gitlabProjectId, gitlabPath, gitlabWebUrl, defaultBranch, testsPath } = project;
    if (gitlabProjectId === null || !gitlabPath || !gitlabWebUrl || !defaultBranch || !testsPath) {
      throw new ConflictException('Project is not linked to a GitLab repository');
    }
    return {
      ...project,
      gitlabProjectId,
      gitlabPath,
      gitlabWebUrl,
      defaultBranch,
      testsPath,
      playwrightConfigPath: project.playwrightConfigPath ?? 'playwright.config.ts',
    };
  }

  /** The default branch plus the caller's own work branches, each with its latest merge request. */
  async branches(projectId: string, user: AuthUser) {
    const project = await this.requireLinked(projectId);
    const connection = await this.gitlab.requireConnection(user.id);
    const prefix = workBranchPrefix(connection.username);
    return this.gitlab.withToken(user.id, async (token) => {
      const work = (await this.api.listBranches(token, project.gitlabProjectId, prefix))
        .filter((b) => b.name.startsWith(prefix) && b.name !== project.defaultBranch)
        .sort((a, b) => a.name.localeCompare(b.name));
      const branches: { name: string; isDefault: boolean; mergeRequest: MergeRequestRef | null }[] = [
        { name: project.defaultBranch, isDefault: true, mergeRequest: null },
      ];
      for (const b of work) {
        const [mr] = await this.api.listMergeRequests(token, project.gitlabProjectId, { sourceBranch: b.name, state: 'all' });
        branches.push({ name: b.name, isDefault: false, mergeRequest: mr ? toRef(mr) : null });
      }
      return { defaultBranch: project.defaultBranch, branches };
    });
  }

  async tree(projectId: string, ref: string | undefined, user: AuthUser) {
    const project = await this.requireLinked(projectId);
    const branch = ref ?? project.defaultBranch;
    const entries = await this.gitlab.withToken(user.id, (token) => this.api.listTree(token, project.gitlabProjectId, branch, project.testsPath));
    return { ref: branch, testsPath: project.testsPath, entries };
  }

  async readFile(projectId: string, query: FileQueryDto, user: AuthUser) {
    const project = await this.requireLinked(projectId);
    const path = resolveInTestsPath(project.testsPath, query.path);
    const ref = query.ref ?? project.defaultBranch;
    return this.gitlab.withToken(user.id, async (token) => {
      // Learn the size before downloading anything: a multi-megabyte blob should never be pulled
      // into memory just to tell the caller it can't be opened.
      const head = await this.api.headFile(token, project.gitlabProjectId, ref, path);
      if (!head) throw new NotFoundException(`File "${path}" was not found on ${ref}`);
      if (head.size > MAX_VIEWABLE_BYTES) {
        throw new PayloadTooLargeException("Files larger than 5 MB can't be opened here");
      }
      const file = await this.api.getFile(token, project.gitlabProjectId, ref, path);
      if (!file) throw new NotFoundException(`File "${path}" was not found on ${ref}`);
      return {
        path,
        ref,
        content: file.content,
        lastCommitId: file.lastCommitId,
        size: file.size,
        readOnly: file.size > MAX_EDITABLE_BYTES || !file.isValidUtf8 || !/\.(ts|js)$/.test(path),
      };
    });
  }

  /**
   * Commits one file to the caller's work branch (created from the default branch on first save)
   * and opens or updates that branch's merge request. Never commits to the default branch.
   */
  async saveFile(projectId: string, dto: SaveFileDto, user: AuthUser): Promise<SaveFileResult> {
    const project = await this.requireLinked(projectId);
    const path = resolveEditablePath(project.testsPath, dto.path);
    if (Buffer.byteLength(dto.content, 'utf8') > MAX_EDITABLE_BYTES) {
      throw new PayloadTooLargeException('Files larger than 1 MB are read-only');
    }
    const connection = await this.gitlab.requireConnection(user.id);
    const branch = workBranchName(connection.username, dto.branchSlug);
    if (branch === project.defaultBranch) throw new BadRequestException('The tool never commits to the default branch');
    const pid = project.gitlabProjectId;

    return this.gitlab.withToken(user.id, async (token) => {
      const branchExists = (await this.api.getBranch(token, pid, branch)) !== null;
      const baseRef = branchExists ? branch : project.defaultBranch;

      // HEAD first: an existing file's size decides whether it can be edited at all, before any of
      // its content is downloaded (a file over the limit must never be pulled into memory just to
      // reject it).
      const head = await this.api.headFile(token, pid, baseRef, path);
      if (head && head.size > MAX_EDITABLE_BYTES) {
        throw new PayloadTooLargeException('Files larger than 1 MB are read-only');
      }
      if (head && !dto.lastCommitId) {
        throw new ConflictException(FILE_EXISTS_MESSAGE);
      }
      if ((head && dto.lastCommitId !== head.lastCommitId) || (!head && dto.lastCommitId)) {
        throw new ConflictException(STALE_FILE_MESSAGE);
      }
      // The client only sees readOnly: true for this; enforce it here too, by re-reading the bytes
      // (now known to be within the editable size budget, so this never downloads an oversized file).
      if (head) {
        const current = await this.api.getFile(token, pid, baseRef, path);
        if (current && !current.isValidUtf8) {
          throw new BadRequestException(NOT_UTF8_MESSAGE);
        }
      }

      const isUpdate = head !== null;
      const commitOnce = (startBranch: string | undefined) =>
        this.api.createCommit(token, pid, {
          branch,
          startBranch,
          message: `${isUpdate ? 'Update' : 'Add'} ${path} (Ejad test cases)`,
          actions: [{ action: isUpdate ? 'update' : 'create', filePath: path, content: dto.content, lastCommitId: head?.lastCommitId }],
        });

      let commit: GitlabCommit;
      try {
        commit = await commitOnce(branchExists ? undefined : project.defaultBranch);
      } catch (e) {
        if (!branchExists && e instanceof GitlabHttpError && e.status === 400 && /branch .* already exists/i.test(e.message)) {
          // A concurrent first save to this same work branch won the race to create it. It exists
          // now, so retry the exact same commit without start_branch instead of failing the save.
          try {
            commit = await commitOnce(undefined);
          } catch (e2) {
            throw this.toSaveConflict(e2, isUpdate);
          }
        } else {
          throw this.toSaveConflict(e, isUpdate);
        }
      }

      return { branch, commitId: commit.id, mergeRequest: await this.openOrUpdateMergeRequest(token, pid, project.defaultBranch, branch, dto, path, commit) };
    });
  }

  /**
   * Maps a failed commit to the conflict the caller should see. A push between our check and the
   * commit: GitLab rejects it. A create that now finds the file already there is the file-exists
   * conflict; an update whose branch moved on ("changed since" / "doesn't exist") is the generic
   * stale-file conflict. Anything else (including a GitlabHttpError for something unrelated) is
   * passed through unchanged.
   */
  private toSaveConflict(e: unknown, isUpdate: boolean): unknown {
    if (e instanceof GitlabHttpError && e.status === 400) {
      if (!isUpdate && /already exists/i.test(e.message)) {
        return new ConflictException(FILE_EXISTS_MESSAGE);
      }
      if (isUpdate && /changed since|doesn't exist/i.test(e.message)) {
        return new ConflictException(STALE_FILE_MESSAGE);
      }
    }
    return e;
  }

  /**
   * Opens or updates the work branch's merge request after a commit has already landed. The
   * commit is never rolled back on failure here: a merge request that couldn't be created or
   * updated just means the caller gets `mergeRequest: null` back, not a failed save.
   */
  private async openOrUpdateMergeRequest(
    token: string,
    pid: number,
    defaultBranch: string,
    branch: string,
    dto: SaveFileDto,
    path: string,
    commit: GitlabCommit,
  ): Promise<MergeRequestRef | null> {
    const codes = extractCaseTags(dto.content);
    try {
      const [open] = await this.api.listMergeRequests(token, pid, { sourceBranch: branch, state: 'opened' });
      if (open) {
        return toRef(await this.api.updateMergeRequest(token, pid, open.iid, { description: buildMrDescription(open.description, path, codes) }));
      }
      try {
        return toRef(
          await this.api.createMergeRequest(token, pid, {
            sourceBranch: branch,
            targetBranch: defaultBranch,
            title: mergeRequestTitle(dto.branchSlug),
            description: buildMrDescription(null, path, codes),
          }),
        );
      } catch (e) {
        // Someone else opened one for this branch between our list and our create: reuse theirs.
        if (e instanceof GitlabHttpError && e.status === 409) {
          const [existing] = await this.api.listMergeRequests(token, pid, { sourceBranch: branch, state: 'opened' });
          if (existing) {
            return toRef(
              await this.api.updateMergeRequest(token, pid, existing.iid, { description: buildMrDescription(existing.description, path, codes) }),
            );
          }
        }
        throw e;
      }
    } catch (e) {
      this.logger.warn(`Commit ${commit.id} on ${branch} succeeded but opening/updating its merge request failed: ${(e as Error).message}`);
      return null;
    }
  }
}
