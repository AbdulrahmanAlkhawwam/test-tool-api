import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../../common/decorators/is-optional-non-null.decorator';

export class SaveFileDto {
  /** Repository path inside the project's tests folder. */
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  path!: string;

  @IsString()
  content!: string;

  /** last_commit_id from GET …/automation/file; omit only when creating a new file. */
  @IsOptionalNonNull()
  @IsString()
  @Matches(/^[0-9a-f]{7,64}$/, { message: 'lastCommitId must be a commit SHA' })
  lastCommitId?: string;

  /** Short work name, e.g. "login fixes" → branch tests/<gitlab-username>/login-fixes. */
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  branchSlug!: string;
}
