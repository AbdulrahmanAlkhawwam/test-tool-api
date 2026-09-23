import { Transform, Type } from 'class-transformer';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../../common/decorators/is-optional-non-null.decorator';

export class CreateApiTokenDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  /** 30, 90 or 180 days (spec §4). Default 90. An explicit `null` is rejected, not defaulted. */
  @IsOptionalNonNull()
  @Type(() => Number)
  @IsIn([30, 90, 180])
  expiresInDays: number = 90;
}
