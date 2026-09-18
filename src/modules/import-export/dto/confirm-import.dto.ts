import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class ConfirmImportDto {
  @IsUUID()
  importId!: string;

  /** What to do with rows whose ID already exists in the project. */
  @IsOptional() @IsIn(['skip', 'update'])
  duplicateStrategy: 'skip' | 'update' = 'skip';

  /** Also create a completed run holding the Status / Actual Result columns. */
  @IsOptional() @IsBoolean()
  createImportedRun: boolean = false;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(150)
  runName?: string;
}
