import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { TokenCipher } from '../../common/crypto/token-cipher';
import { GitlabConfig } from '../../config/configuration';
import { GitlabApiService } from './gitlab-api.service';
import { GitlabConnectionService } from './gitlab-connection.service';
import { GitlabEnabledGuard } from './gitlab-enabled.guard';
import { GitlabController } from './gitlab.controller';

@Module({
  controllers: [GitlabController],
  providers: [
    GitlabApiService,
    GitlabConnectionService,
    GitlabEnabledGuard,
    {
      provide: TokenCipher,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const cfg = config.getOrThrow<GitlabConfig>('gitlab');
        // With GitLab disabled nothing is ever encrypted; a throwaway key keeps the provider constructible.
        return new TokenCipher(cfg.enabled ? cfg.tokenEncryptionKey : randomBytes(32).toString('base64'));
      },
    },
  ],
  exports: [GitlabApiService, GitlabConnectionService, GitlabEnabledGuard, TokenCipher],
})
export class GitlabModule {}
