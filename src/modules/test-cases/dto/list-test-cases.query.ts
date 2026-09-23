import { Priority, ResultStatus, ReviewState } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class ListTestCasesQuery {
  @IsOptional() @IsUUID()
  moduleId?: string;

  @IsOptional() @IsEnum(Priority)
  priority?: Priority;

  /** Filter by latest executed status. NOT_EXECUTED = never executed. */
  @IsOptional() @IsEnum(ResultStatus)
  status?: ResultStatus;

  /** AI_DRAFT shows the AI drafts only; APPROVED shows reviewed cases only; omitted shows both. */
  @IsOptional() @IsEnum(ReviewState)
  reviewState?: ReviewState;

  @IsOptional() @IsString() @MaxLength(200)
  q?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  pageSize: number = 50;
}
