import { Priority } from '@prisma/client';
import { IsEnum, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../../common/decorators/is-optional-non-null.decorator';

export class CreateCaseFromResultDto {
  @IsUUID()
  moduleId!: string;

  /** Defaults to the test title without the file/describe path and tags. */
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  name?: string;

  @IsOptionalNonNull()
  @IsEnum(Priority)
  priority?: Priority;
}
