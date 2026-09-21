import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GitlabConnection, GitlabConnectionState, Prisma } from '@prisma/client';
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

export interface CompleteOAuthResult {
  status: 'connected';
  username: string;
}

/** `reason` is one of invalid_state | denied | exchange_failed | already_linked. */
export type CompleteOAuthFailureReason = 'invalid_state' | 'denied' | 'exchange_failed' | 'already_linked';

const notConnected = () =>
  new ForbiddenException({ message: 'Connect GitLab to use automation', details: { code: GITLAB_NOT_CONNECTED } });
const needsReconnect = () =>
  new ForbiddenException({
    message: 'Your GitLab connection expired – reconnect GitLab to continue',
    details: { code: GITLAB_NEEDS_RECONNECT },
  });
const completionFailed = (reason: CompleteOAuthFailureReason) =>
  new BadRequestException({ message: 'Could not connect GitLab', details: { reason } });

/** GitLab statuses that mean the refresh token itself was rejected (and only these mark NEEDS_RECONNECT). */
const isRefreshRejected = (e: GitlabHttpError) => e.status === 400 || e.status === 401;

@Injectable()
export class GitlabConnectionService {
  private readonly logger = new Logger(GitlabConnectionService.name);

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
    // Drop expired states, and this user's other unused ones: only the newest link they started works.
    await this.prisma.gitlabOAuthState.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { userId, usedAt: null }] },
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

  /**
   * Completes the OAuth flow for the signed-in user. GitLab redirects the browser to
   * `WEB_URL/gitlab/callback`; the web app then calls this endpoint with the code/state.
   * Requiring the caller to be authenticated as the state's own owner (rather than accepting a
   * public, stateless callback) stops one tool user from linking another's GitLab tokens to their
   * own account by sending them their `authorizeUrl` — the state is looked up but never consumed
   * when it belongs to someone else, so its rightful owner can still complete it afterwards.
   */
  async completeOAuth(userId: string, params: { code?: string; state: string; error?: string }): Promise<CompleteOAuthResult> {
    const row = await this.prisma.gitlabOAuthState.findUnique({ where: { stateHash: sha256Hex(params.state) } });
    if (!row || row.userId !== userId) throw completionFailed('invalid_state');

    // Claim the state atomically: only one call can use it, and only before it expires. The
    // ownership check above already guarantees only the user it was issued for gets this far.
    const now = new Date();
    const claimed = await this.prisma.gitlabOAuthState.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) throw completionFailed('invalid_state');
    if (params.error || !params.code) throw completionFailed('denied');

    let tokens: OAuthTokens;
    let gitlabUser: GitlabUser;
    try {
      tokens = await this.api.exchangeCode(params.code, this.cipher.decrypt(row.codeVerifierEnc));
      gitlabUser = await this.api.getCurrentUser(tokens.accessToken);
    } catch (e) {
      if (!(e instanceof GitlabHttpError)) this.logger.error(`GitLab OAuth exchange failed: ${(e as Error).message}`);
      throw completionFailed('exchange_failed');
    }

    // One GitLab identity can only ever be linked to one tool user.
    const existing = await this.prisma.gitlabConnection.findUnique({ where: { gitlabUserId: gitlabUser.id } });
    if (existing && existing.userId !== userId) {
      await this.api.revokeToken(tokens.accessToken).catch(() => {});
      throw completionFailed('already_linked');
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
    try {
      await this.prisma.gitlabConnection.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    } catch (e) {
      // The unique index on gitlabUserId is the real guard: a concurrent completion could have
      // linked this GitLab identity to someone else between the check above and this write.
      const isUniqueViolation = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
      await this.api.revokeToken(tokens.accessToken).catch(() => {});
      if (isUniqueViolation) throw completionFailed('already_linked');
      this.logger.error(`GitLab OAuth completion failed: ${(e as Error).message}`);
      throw completionFailed('exchange_failed');
    }
    return { status: 'connected', username: gitlabUser.username };
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

  /**
   * Refreshes `connection`'s access token. GitLab refresh tokens are single-use, so this re-reads
   * the row first: another request may already have rotated it (or the token may simply be fresh
   * again) between the caller's read and this call — in which case GitLab is not called again.
   * The eventual write is itself conditional on the refresh token this call saw, so even a second
   * concurrent refresh that slipped past the in-process `refreshing` lock (e.g. because its own
   * stale read reached here only after the first one fully finished) can't spend an
   * already-rotated refresh token and wrongly mark the connection NEEDS_RECONNECT.
   */
  private async refresh(connection: GitlabConnection): Promise<string> {
    const seenRefreshTokenEnc = connection.refreshTokenEnc;
    const fresh = await this.prisma.gitlabConnection.findUnique({ where: { id: connection.id } });
    if (!fresh) throw notConnected();
    if (fresh.refreshTokenEnc !== seenRefreshTokenEnc || fresh.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) {
      return this.cipher.decrypt(fresh.accessTokenEnc);
    }

    let tokens: OAuthTokens;
    try {
      tokens = await this.api.refreshTokens(this.cipher.decrypt(fresh.refreshTokenEnc));
    } catch (e) {
      if (e instanceof GitlabHttpError && isRefreshRejected(e)) {
        await this.markNeedsReconnect(fresh.userId);
        throw needsReconnect();
      }
      if (e instanceof GitlabHttpError) throw toHttpException(e);
      throw e;
    }

    const updated = await this.prisma.gitlabConnection.updateMany({
      where: { id: fresh.id, refreshTokenEnc: fresh.refreshTokenEnc },
      data: {
        accessTokenEnc: this.cipher.encrypt(tokens.accessToken),
        refreshTokenEnc: this.cipher.encrypt(tokens.refreshToken),
        expiresAt: tokens.expiresAt,
        state: GitlabConnectionState.ACTIVE,
      },
    });
    if (updated.count === 0) {
      // Someone else refreshed, or disconnected, between our re-read and this write.
      const after = await this.prisma.gitlabConnection.findUnique({ where: { id: fresh.id } });
      if (!after) {
        await this.api.revokeToken(tokens.accessToken).catch(() => {});
        throw notConnected();
      }
      return this.cipher.decrypt(after.accessTokenEnc);
    }
    return tokens.accessToken;
  }
}
