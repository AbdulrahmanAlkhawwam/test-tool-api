import { randomBytes, timingSafeEqual } from 'crypto';
import { sha256Hex } from '../../common/crypto/token-cipher';

export const PAT_PREFIX = 'ejad_pat_';
/** Random characters after the prefix. 32 base62 chars ≈ 190 bits. */
export const PAT_BODY_LENGTH = 32;
/** How much of the random body is stored in clear text so a user can recognise the token. */
export const PAT_VISIBLE_PREFIX_LENGTH = 8;

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
 * Constant-time hash comparison. Both hashes are fixed-length hex, so a length mismatch can
 * only come from corrupt data; it returns false without calling timingSafeEqual (which throws
 * on differing lengths).
 */
export function verifyApiTokenHash(candidateHash: string, storedHash: string): boolean {
  if (candidateHash.length !== storedHash.length) return false;
  return timingSafeEqual(Buffer.from(candidateHash, 'hex'), Buffer.from(storedHash, 'hex'));
}

/** True for values shaped like a PAT. Used to keep browser JWTs off the MCP endpoint. */
export function isApiTokenFormat(value: string): boolean {
  return PAT_RE.test(value);
}
