import { Priority } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';

export const SELECTION_MODES = ['ALL', 'MODULES', 'PRIORITIES', 'CASES'] as const;
export type SelectionMode = (typeof SELECTION_MODES)[number];

export class RunSelectionDto {
  @IsIn(SELECTION_MODES)
  mode!: SelectionMode;

  @IsOptional() @IsArray() @IsUUID('all', { each: true })
  moduleIds?: string[];

  @IsOptional() @IsArray() @IsEnum(Priority, { each: true })
  priorities?: Priority[];

  @IsOptional() @IsArray() @IsUUID('all', { each: true })
  caseIds?: string[];
}

export class CreateRunDto {
  @IsString() @MinLength(1) @MaxLength(150)
  name!: string;

  @IsOptional() @IsString() @MaxLength(100)
  build?: string;

  @IsOptional() @IsString() @MaxLength(100)
  environment?: string;

  @ValidateNested()
  @Type(() => RunSelectionDto)
  selection!: RunSelectionDto;
}
