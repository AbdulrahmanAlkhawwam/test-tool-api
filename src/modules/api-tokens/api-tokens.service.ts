import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ApiTokenPurpose, Prisma } from '@prisma/client';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { apiTokenPrefix, generateApiToken, hashApiToken, isApiTokenFormat, verifyApiTokenHash } from './api-token';
import { CreateApiTokenDto } from './dto/create-api-token.dto';

/** Uniform message for every token problem (spec §10): callers must not learn which one it was. */
const BAD_TOKEN = 'Invalid or expired access token';
/** lastUsedAt is refreshed at most this often, so a busy AI session is not one write per call. */
const LAST_USED_INTERVAL_MS = 60_000;

const TOKEN_META = {
  id: true,
  name: true,
  prefix: true,
  purpose: true,
  createdAt: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
} satisfies Prisma.ApiTokenSelect;

export interface ApiTokenMeta {
  id: string;
  name: string;
  prefix: string;
  purpose: ApiTokenPurpose;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface VerifiedApiToken {
  tokenId: string;
  lastUsedAt: Date | null;
  user: AuthUser;
}

@Injectable()
export class ApiTokensService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string): Promise<ApiTokenMeta[]> {
    return this.prisma.apiToken.findMany({ where: { userId }, select: TOKEN_META, orderBy: { createdAt: 'desc' } });
  }

  async create(userId: string, dto: CreateApiTokenDto): Promise<ApiTokenMeta & { token: string }> {
    const token = generateApiToken();
    const meta = await this.prisma.apiToken.create({
      data: {
        userId,
        name: dto.name,
        purpose: ApiTokenPurpose.MCP,
        tokenHash: hashApiToken(token),
        prefix: apiTokenPrefix(token),
        expiresAt: new Date(Date.now() + dto.expiresInDays * 86_400_000),
      },
      select: TOKEN_META,
    });
    // The only place the raw token ever leaves the process.
    return { ...meta, token };
  }

  async revoke(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.apiToken.updateMany({
      where: { id, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count !== 1) throw new NotFoundException('Token not found');
  }

  /**
   * Resolves a raw token to its owner, or throws 401. Every failure uses the same message and
   * never includes the token value. The lookup is by unique hash; the stored hash is then
   * re-compared in constant time so a partial-index timing difference cannot leak it.
   */
  async verify(rawToken: string): Promise<VerifiedApiToken> {
    if (!isApiTokenFormat(rawToken)) throw new UnauthorizedException(BAD_TOKEN);
    const candidateHash = hashApiToken(rawToken);
    const row = await this.prisma.apiToken.findUnique({
      where: { tokenHash: candidateHash },
      select: {
        id: true,
        tokenHash: true,
        expiresAt: true,
        revokedAt: true,
        lastUsedAt: true,
        user: { select: { id: true, email: true, name: true, role: true, active: true } },
      },
    });
    if (!row || !verifyApiTokenHash(candidateHash, row.tokenHash)) throw new UnauthorizedException(BAD_TOKEN);
    if (row.revokedAt || row.expiresAt.getTime() <= Date.now()) throw new UnauthorizedException(BAD_TOKEN);
    if (!row.user.active) throw new UnauthorizedException(BAD_TOKEN);
    const { active, ...user } = row.user;
    return { tokenId: row.id, lastUsedAt: row.lastUsedAt, user };
  }

  /** Stamps lastUsedAt at most once per minute per token. */
  async touch(tokenId: string, lastUsedAt: Date | null): Promise<void> {
    const now = Date.now();
    if (lastUsedAt && now - lastUsedAt.getTime() < LAST_USED_INTERVAL_MS) return;
    await this.prisma.apiToken.update({ where: { id: tokenId }, data: { lastUsedAt: new Date(now) } });
  }
}
