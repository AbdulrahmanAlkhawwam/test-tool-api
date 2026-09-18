import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateProjectDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  /** Short unique key, e.g. NINJA. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z][A-Z0-9]{1,9}$/, { message: 'key must be 2–10 uppercase letters/digits, starting with a letter' })
  key!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}
