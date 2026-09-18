import { ResultStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsOptionalNonNull } from '../../../common/decorators/is-optional-non-null.decorator';

export class UpdateResultDto {
  @IsOptionalNonNull() @IsEnum(ResultStatus)
  status?: ResultStatus;

  @IsOptional() @IsString() @MaxLength(10000)
  actualResult?: string | null;

  @IsOptional() @IsString() @MaxLength(5000)
  notes?: string | null;
}
