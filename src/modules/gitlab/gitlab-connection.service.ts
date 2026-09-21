import { BadGatewayException, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GitlabConnection, GitlabConnectionState } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { sha256Hex, TokenCipher } from '../../common/crypto/token-cipher';
import { GitlabConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { GitlabApiService } from './gitlab-api.service';
import { GitlabHttpError, toHttpException } from './gitlab-http-error';
import { GitlabUser, OAuthTokens } from './gitlab.types';

export const GITLAB_NOT_CONNECTED = 'GITLAB_NOT_CONNECTED';
export const GITLAB_NEEDS_RECONNECT = 'GITLAB_NEEDS_RECONNECT';

const STATE_TTL_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 60_000;

export interface GitlabStatus {
  enabled: boolean;
  connection: { username: string; avatarUrl: string | null; state: GitlabConnectionState } | null;
}

const notConnected = () =>
  new ForbiddenException({ message: 'Connect GitLab to use automation', details: { code: GITLAB_NOT_CONNECTED } });
const needsReconnect = () =>
  new ForbiddenException({
    message: 'Your GitLab connection expired – reconnect GitLab to continue',
    details: { code: GITLAB_NEEDS_RECONNECT },
  });

@Injectable()
export class GitlabConnectionService {
  /** One refresh in flight per user: GitLab refresh tokens are single-use (single API instance). */
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly api: GitlabApiService,
    private readonly cipher: TokenCipher,
    private readonly config: ConfigService,
  ) {}

  private get cfg(): GitlabConfig {
    return this.config.getOrThrow<GitlabConfig>('gitlab');
  }

  async status(userId: string): Promise<GitlabStatus> {
    if (!this.cfg.enabled) return { enabled: false, connection: null };
    const c = await this.prisma.gitlabConnection.findUnique({ where: { userId } });
    return { enabled: true, connection: c ? { username: c.username, avatarUrl: c.avatarUrl, state: c.state } : null };
  }

  /** Authorization code flow with PKCE; the random state is stored hashed and bound to the user. */
  async startOAuth(userId: string): Promise<{ authorizeUrl: string }> {
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const now = new Date();
    await this.prisma.gitlabOAuthState.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { userId, usedAt: { not: null } }] },
    });
    await this.prisma.gitlabOAuthState.create({
      data: {
        userId,
        stateHash: sha256Hex(state),
        codeVerifierEnc: this.cipher.encrypt(verifier),
        expiresAt: new Date(now.getTime() + STATE_TTL_MS),
      },
    });
    const url = new URL(`${this.cfg.url}/oauth/authorize`);
    url.searchParams.set('client_id', this.cfg.clientId);
    url.searchParams.set('redirect_uri', this.cfg.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'api');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { authorizeUrl: url.toString() };
  }

  /** Handles the browser redirect from GitLab and returns where to send the browser next. */
  async completeOAuth(params: { code?: string; state?: string; error?: string }): Promise<string> {
    const fail = (reason: string) => `${this.cfg.webUrl}/profile?gitlab=error&reason=${reason}`;
    if (!params.state) return fail('invalid_state');
    const row = await this.prisma.gitlabOAuthState.findUnique({ where: { stateHash: sha256Hex(params.state) } });
    if (!row) return fail('invalid_state');
    // Claim the state atomically: only one callback can use it, and only before it expires.
    const now = new Date();
    const claimed = await this.prisma.gitlabOAuthState.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return fail('invalid_state');
    if (params.error || !params.code) return fail('denied');

    let tokens: OAuthTokens;
    let gitlabUser: GitlabUser;
    try {
      tokens = await this.api.exchangeCode(params.code, this.cipher.decrypt(row.codeVerifierEnc));
      gitlabUser = await this.api.getCurrentUser(tokens.accessToken);
    } catch (e) {
      if (e instanceof GitlabHttpError) return fail('exchange_failed');
      throw e;
    }
    const data = {
      gitlabUserId: gitlabUser.id,
      username: gitlabUser.username,
      avatarUrl: gitlabUser.avatarUrl,
      accessTokenEnc: this.cipher.encrypt(tokens.accessToken),
      refreshTokenEnc: this.cipher.encrypt(tokens.refreshToken),
      expiresAt: tokens.expiresAt,
      state: GitlabConnectionState.ACTIVE,
    };
    await this.prisma.gitlabConnection.upsert({ where: { userId: row.userId }, create: { userId: row.userId, ...data }, update: data });
    return `${this.cfg.webUrl}/profile?gitlab=connected`;
  }

  async disconnect(userId: string): Promise<void> {
    const connection = await this.prisma.gitlabConnection.findUnique({ where: { userId } });
    if (!connection) return;
    try {
      await this.api.revokeToken(this.cipher.decrypt(connection.accessTokenEnc));
    } catch {
      // Best effort: the token is deleted locally either way.
    }
    await this.prisma.gitlabConnection.deleteMany({ where: { userId } });
  }

  async requireConnection(userId: string): Promise<GitlabConnection> {
    const connection = await this.prisma.gitlabConnection.findUnique({ where: { userId } });
    if (!connection) throw notConnected();
    if (connection.state !== GitlabConnectionState.ACTIVE) throw needsReconnect();
    return connection;
  }

  /** A valid access token for the user, refreshed first when it expires within a minute. */
  async accessToken(userId: string): Promise<string> {
    const connection = await this.requireConnection(userId);
    if (connection.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) {
      return this.cipher.decrypt(connection.accessTokenEnc);
    }
    const pending = this.refreshing.get(userId);
    if (pending) return pending;
    const refresh = this.refresh(connection).finally(() => this.refreshing.delete(userId));
    this.refreshing.set(userId, refresh);
    return refresh;
  }

  /** Runs GitLab calls with the user's token and maps GitLab failures to HTTP errors for the client. */
  async withToken<T>(userId: string, fn: (token: string) => Promise<T>): Promise<T> {
    const token = await this.accessToken(userId);
    try {
      return await fn(token);
    } catch (e) {
      if (!(e instanceof GitlabHttpError)) throw e;
      if (e.status === 401) {
        await this.markNeedsReconnect(userId);
        throw needsReconnect();
      }
      throw toHttpException(e);
    }
  }

  async markNeedsReconnect(userId: string): Promise<void> {
    await this.prisma.gitlabConnection.updateMany({ where: { userId }, data: { state: GitlabConnectionState.NEEDS_RECONNECT } });
  }

  private async refresh(connection: GitlabConnection): Promise<string> {
    try {
      const tokens = await this.api.refreshTokens(this.cipher.decrypt(connection.refreshTokenEnc));
      await this.prisma.gitlabConnection.update({
        where: { id: connection.id },
        data: {
          accessTokenEnc: this.cipher.encrypt(tokens.accessToken),
          refreshTokenEnc: this.cipher.encrypt(tokens.refreshToken),
          expiresAt: tokens.expiresAt,
          state: GitlabConnectionState.ACTIVE,
        },
      });
      return tokens.accessToken;
    } catch (e) {
      if (e instanceof GitlabHttpError && e.status > 0 && e.status < 500) {
        await this.markNeedsReconnect(connection.userId);
        throw needsReconnect();
      }
      if (e instanceof GitlabHttpError) throw new BadGatewayException({ message: `GitLab request failed: ${e.message}`, details: { source: 'gitlab' } });
      throw e;
    }
  }
}
