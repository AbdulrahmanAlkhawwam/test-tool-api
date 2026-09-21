import { IsInt, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../../common/decorators/is-optional-non-null.decorator';
import { BRANCH_NAME_RE } from '../paths';

export class LinkRepositoryDto {
  /** GitLab project id (from GET /api/gitlab/projects). */
  @IsInt()
  @Min(1)
  gitlabProjectId!: number;

  /** Defaults to the GitLab project's default branch. */
  @IsOptionalNonNull()
  @IsString()
  @Matches(BRANCH_NAME_RE, { message: 'defaultBranch is not a valid branch name' })
  defaultBranch?: string;

  /** Folder with the Playwright tests, e.g. e2e. */
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  testsPath!: string;

  /** Defaults to playwright.config.ts. */
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  playwrightConfigPath?: string;
}
