import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateRunDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(150)
  name?: string;

  @IsOptional() @IsString() @MaxLength(100)
  build?: string;

  @IsOptional() @IsString() @MaxLength(100)
  environment?: string;

  /** Only transition allowed: IN_PROGRESS → COMPLETED. */
  @IsOptional() @IsIn(['COMPLETED'])
  status?: 'COMPLETED';
}
