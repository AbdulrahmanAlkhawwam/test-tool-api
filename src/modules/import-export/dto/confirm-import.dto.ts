import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../../common/decorators/is-optional-non-null.decorator';

export class ConfirmImportDto {
  @IsUUID()
  importId!: string;

  /** What to do with rows whose ID already exists in the project. */
  @IsOptionalNonNull() @IsIn(['skip', 'update'])
  duplicateStrategy: 'skip' | 'update' = 'skip';

  /** Also create a completed run holding the Status / Actual Result columns. */
  @IsOptionalNonNull() @IsBoolean()
  createImportedRun: boolean = false;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(150)
  runName?: string;
}
