import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../../common/decorators/is-optional-non-null.decorator';

export class UpdateProjectDto {
  @IsOptionalNonNull()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptionalNonNull()
  @IsBoolean()
  archived?: boolean;
}
