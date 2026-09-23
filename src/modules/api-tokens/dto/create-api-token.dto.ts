import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateApiTokenDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  /** 30, 90 or 180 days (spec §4). Default 90. */
  @IsOptional()
  @Type(() => Number)
  @IsIn([30, 90, 180])
  expiresInDays: number = 90;
}
