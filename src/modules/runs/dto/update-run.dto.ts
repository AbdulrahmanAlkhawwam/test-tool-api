import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../../common/decorators/is-optional-non-null.decorator';

export class UpdateRunDto {
  @IsOptionalNonNull() @IsString() @MinLength(1) @MaxLength(150)
  name?: string;

  @IsOptional() @IsString() @MaxLength(100)
  build?: string;

  @IsOptional() @IsString() @MaxLength(100)
  environment?: string;

  /** Only transition allowed: IN_PROGRESS → COMPLETED. */
  @IsOptionalNonNull() @IsIn(['COMPLETED'])
  status?: 'COMPLETED';
}
