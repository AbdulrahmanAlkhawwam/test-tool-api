import { ResultStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateResultDto {
  @IsOptional() @IsEnum(ResultStatus)
  status?: ResultStatus;

  @IsOptional() @IsString() @MaxLength(10000)
  actualResult?: string;

  @IsOptional() @IsString() @MaxLength(5000)
  notes?: string;
}
