import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { BRANCH_NAME_RE } from '../paths';

export class RefQueryDto {
  /** Branch to read; defaults to the project's default branch. */
  @IsOptional()
  @IsString()
  @Matches(BRANCH_NAME_RE, { message: 'ref is not a valid branch name' })
  ref?: string;
}

export class FileQueryDto extends RefQueryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  path!: string;
}
