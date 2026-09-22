import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDefined, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { BRANCH_NAME_RE } from '../../automation/paths';

export const AUTOMATED_SCOPE_MODES = ['ALL', 'PATH', 'CASES'] as const;
export type AutomatedScopeMode = (typeof AUTOMATED_SCOPE_MODES)[number];

export class AutomatedScopeDto {
  @IsIn(AUTOMATED_SCOPE_MODES)
  mode!: AutomatedScopeMode;

  /** Folder or file inside the tests folder (mode PATH). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  path?: string;

  /** Test cases to run by their @TC tag (mode CASES). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  caseIds?: string[];
}

export class CreateAutomatedRunDto {
  @IsString()
  @Matches(BRANCH_NAME_RE, { message: 'branch is not a valid branch name' })
  branch!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name?: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => AutomatedScopeDto)
  scope!: AutomatedScopeDto;
}
