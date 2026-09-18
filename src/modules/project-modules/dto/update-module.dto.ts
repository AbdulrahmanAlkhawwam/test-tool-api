import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../../common/decorators/is-optional-non-null.decorator';

/** Same rules as CreateModuleDto, all optional; `null` is rejected (both columns are required). */
export class UpdateModuleDto {
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  /** Used in test case IDs: TC-{code}-001. */
  @IsOptionalNonNull()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z][A-Z0-9]{0,9}$/, { message: 'code must be 1–10 uppercase letters/digits, starting with a letter' })
  code?: string;
}
