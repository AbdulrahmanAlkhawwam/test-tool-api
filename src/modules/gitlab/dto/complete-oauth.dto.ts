import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** Body the web app sends after GitLab redirects it to WEB_URL/gitlab/callback. */
export class CompleteOAuthDto {
  @IsString()
  @IsNotEmpty()
  state!: string;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  error?: string;
}
