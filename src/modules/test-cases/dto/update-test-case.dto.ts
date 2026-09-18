import { OmitType, PartialType } from '@nestjs/swagger';
import { Priority } from '@prisma/client';
import { IsEnum, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../../common/decorators/is-optional-non-null.decorator';
import { CreateTestCaseDto } from './create-test-case.dto';

/**
 * PartialType marks every field `@IsOptional()` (which also skips `null`), so the
 * non-nullable fields are redeclared here to reject an explicit `null`.
 */
export class UpdateTestCaseDto extends PartialType(OmitType(CreateTestCaseDto, ['moduleId', 'name', 'priority'] as const)) {
  @IsOptionalNonNull() @IsUUID()
  moduleId?: string;

  @IsOptionalNonNull() @IsString() @MinLength(1) @MaxLength(300)
  name?: string;

  @IsOptionalNonNull() @IsEnum(Priority)
  priority?: Priority;
}
