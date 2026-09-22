import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { GitlabApiService } from '../gitlab/gitlab-api.service';
import { GitlabConnectionService } from '../gitlab/gitlab-connection.service';
import { ProjectsService } from '../projects/projects.service';
import { LinkRepositoryDto } from './dto/link-repository.dto';
import { normalizeRepoPath } from './paths';

export const REPOSITORY_SELECT = {
  id: true,
  gitlabProjectId: true,
  gitlabPath: true,
  gitlabWebUrl: true,
  defaultBranch: true,
  testsPath: true,
  playwrightConfigPath: true,
} satisfies Prisma.ProjectSelect;

@Injectable()
export class RepositoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly gitlab: GitlabConnectionService,
    private readonly api: GitlabApiService,
  ) {}

  /** Links a GitLab project the admin can access (checked with the admin's own token). */
  async link(projectId: string, dto: LinkRepositoryDto, user: AuthUser) {
    await this.projects.requireProject(projectId);
    const testsPath = normalizeRepoPath(dto.testsPath);
    const playwrightConfigPath = normalizeRepoPath(dto.playwrightConfigPath ?? 'playwright.config.ts');

    const repo = await this.gitlab.withToken(user.id, async (token) => {
      const project = await this.api.getProject(token, dto.gitlabProjectId);
      const defaultBranch = dto.defaultBranch ?? project.defaultBranch;
      if (!defaultBranch) {
        throw new BadRequestException(`${project.pathWithNamespace} has no default branch yet – push a first commit`);
      }
      if (dto.defaultBranch && !(await this.api.getBranch(token, project.id, dto.defaultBranch))) {
        throw new BadRequestException(`Branch "${dto.defaultBranch}" does not exist in ${project.pathWithNamespace}`);
      }
      return { project, defaultBranch };
    });

    return this.prisma.project.update({
      where: { id: projectId },
      data: {
        gitlabProjectId: repo.project.id,
        gitlabPath: repo.project.pathWithNamespace,
        gitlabWebUrl: repo.project.webUrl,
        defaultBranch: repo.defaultBranch,
        testsPath,
        playwrightConfigPath,
      },
      select: REPOSITORY_SELECT,
    });
  }

  /** Clears the link; runs keep their branch/pipeline history. */
  async unlink(projectId: string): Promise<void> {
    await this.projects.requireProject(projectId);
    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        gitlabProjectId: null,
        gitlabPath: null,
        gitlabWebUrl: null,
        defaultBranch: null,
        testsPath: null,
        playwrightConfigPath: null,
      },
      select: { id: true },
    });
  }
}
