import { Priority } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateTestCaseDto {
  @IsUUID()
  moduleId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  name!: string;

  @IsOptional() @IsString() @MaxLength(5000)
  description?: string;

  @IsOptional() @IsString() @MaxLength(5000)
  preconditions?: string;

  @IsOptional() @IsString() @MaxLength(10000)
  steps?: string;

  @IsOptional() @IsString() @MaxLength(5000)
  testData?: string;

  @IsOptional() @IsString() @MaxLength(5000)
  expectedResult?: string;

  @IsOptional() @IsEnum(Priority)
  priority?: Priority;

  @IsOptional() @IsString() @MaxLength(5000)
  notes?: string;
}
