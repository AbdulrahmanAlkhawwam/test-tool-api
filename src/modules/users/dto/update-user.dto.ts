import { Role } from '@prisma/client';
import { IsBoolean, IsEnum, IsString, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../../common/decorators/is-optional-non-null.decorator';

export class UpdateUserDto {
  @IsOptionalNonNull()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @IsOptionalNonNull()
  @IsEnum(Role)
  role?: Role;

  @IsOptionalNonNull()
  @IsBoolean()
  active?: boolean;

  @IsOptionalNonNull()
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password?: string;
}
