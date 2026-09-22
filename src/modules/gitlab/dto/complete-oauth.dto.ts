import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** Body the web app sends after GitLab redirects it to its own /gitlab/callback. */
export class CompleteOAuthDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  state!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  error?: string;
}
