import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateModuleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  /** Used in test case IDs: TC-{code}-001. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z][A-Z0-9]{0,9}$/, { message: 'code must be 1–10 uppercase letters/digits, starting with a letter' })
  code!: string;
}
