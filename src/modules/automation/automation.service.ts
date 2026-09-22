import { BadRequestException, ConflictException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
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
export const STALE_FILE_MESSAGE = 'This file changed on the branch – reload it before saving';

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

const toRef = (mr: GitlabMergeRequest): MergeRequestRef => ({ iid: mr.iid, webUrl: mr.webUrl, state: mr.state });

@Injectable()
export class AutomationService {
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
        .filter((b) => b.name.startsWith(prefix))
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
    const file = await this.gitlab.withToken(user.id, (token) => this.api.getFile(token, project.gitlabProjectId, ref, path));
    if (!file) throw new NotFoundException(`File "${path}" was not found on ${ref}`);
    return {
      path,
      ref,
      content: file.content,
      lastCommitId: file.lastCommitId,
      size: file.size,
      readOnly: file.size > MAX_EDITABLE_BYTES || !/\.(ts|js)$/.test(path),
    };
  }

  /**
   * Commits one file to the caller's work branch (created from the default branch on first save)
   * and opens or updates that branch's merge request. Never commits to the default branch.
   */
  async saveFile(projectId: string, dto: SaveFileDto, user: AuthUser) {
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
      const current = await this.api.getFile(token, pid, branchExists ? branch : project.defaultBranch, path);
      if (current && !dto.lastCommitId) {
        throw new ConflictException('A file with this path already exists – open it before saving');
      }
      if ((current && dto.lastCommitId !== current.lastCommitId) || (!current && dto.lastCommitId)) {
        throw new ConflictException(STALE_FILE_MESSAGE);
      }

      let commit: GitlabCommit;
      try {
        commit = await this.api.createCommit(token, pid, {
          branch,
          startBranch: branchExists ? undefined : project.defaultBranch,
          message: `${current ? 'Update' : 'Add'} ${path} (Ejad test cases)`,
          actions: [{ action: current ? 'update' : 'create', filePath: path, content: dto.content, lastCommitId: current?.lastCommitId }],
        });
      } catch (e) {
        // A push between our check and the commit: GitLab rejects the stale last_commit_id.
        if (e instanceof GitlabHttpError && e.status === 400 && /changed since|already exists|doesn't exist/i.test(e.message)) {
          throw new ConflictException(STALE_FILE_MESSAGE);
        }
        throw e;
      }

      const codes = extractCaseTags(dto.content);
      const [open] = await this.api.listMergeRequests(token, pid, { sourceBranch: branch, state: 'opened' });
      const mr = open
        ? await this.api.updateMergeRequest(token, pid, open.iid, { description: buildMrDescription(open.description, path, codes) })
        : await this.api.createMergeRequest(token, pid, {
            sourceBranch: branch,
            targetBranch: project.defaultBranch,
            title: mergeRequestTitle(dto.branchSlug),
            description: buildMrDescription(null, path, codes),
          });
      return { branch, commitId: commit.id, mergeRequest: toRef(mr) };
    });
  }
}
