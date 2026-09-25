import { randomBytes, timingSafeEqual } from 'crypto';
import { sha256Hex } from '../../common/crypto/token-cipher';

export const PAT_PREFIX = 'ejad_pat_';
/** Random characters after the prefix. 32 base62 chars ≈ 190 bits. */
export const PAT_BODY_LENGTH = 32;
/** How much of the random body is stored in clear text so a user can recognise the token. */
const PAT_VISIBLE_PREFIX_LENGTH = 8;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** 248 = 4 × 62: bytes at or above it are discarded so every character is equally likely. */
const BASE62_LIMIT = 248;

const PAT_RE = new RegExp(`^${PAT_PREFIX}[0-9A-Za-z]{${PAT_BODY_LENGTH}}$`);

/** A fresh token. Shown to the user once; only its hash and visible prefix are stored. */
export function generateApiToken(): string {
  let body = '';
  while (body.length < PAT_BODY_LENGTH) {
    for (const byte of randomBytes(PAT_BODY_LENGTH)) {
      if (byte >= BASE62_LIMIT) continue; // rejection sampling: keeps the distribution uniform
      body += BASE62[byte % 62];
      if (body.length === PAT_BODY_LENGTH) break;
    }
  }
  return PAT_PREFIX + body;
}

export function hashApiToken(token: string): string {
  return sha256Hex(token);
}

/** The part of the token a user sees in the token list (never the whole secret). */
export function apiTokenPrefix(token: string): string {
  return token.slice(PAT_PREFIX.length, PAT_PREFIX.length + PAT_VISIBLE_PREFIX_LENGTH);
}

/**
 * Defensive equality check on the row `ApiTokensService#verify` already found by an equality
 * lookup on `tokenHash`'s unique index — it can never reject that row, so it is not a timing
 * mitigation. It guards against corrupt stored data: a `storedHash` that is the right string
 * length (64) but not valid hex decodes to fewer than 32 bytes, which would make
 * `timingSafeEqual` throw a RangeError instead of failing closed. The actual defence against
 * guessing a token is its entropy — ~190 bits behind SHA-256 (see PAT_BODY_LENGTH).
 */
export function verifyApiTokenHash(candidateHash: string, storedHash: string): boolean {
  if (candidateHash.length !== storedHash.length) return false;
  const candidate = Buffer.from(candidateHash, 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (candidate.length !== 32 || stored.length !== 32) return false;
  return timingSafeEqual(candidate, stored);
}

/** True for values shaped like a PAT. Used to keep browser JWTs off the MCP endpoint. */
export function isApiTokenFormat(value: string): boolean {
  return PAT_RE.test(value);
}
