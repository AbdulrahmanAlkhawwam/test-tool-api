import { createHash } from 'crypto';
import {
  apiTokenPrefix,
  generateApiToken,
  hashApiToken,
  isApiTokenFormat,
  PAT_PREFIX,
  verifyApiTokenHash,
} from './api-token';

describe('api-token', () => {
  it('generates ejad_pat_ + 32 base62 characters', () => {
    const token = generateApiToken();
    expect(token.startsWith(PAT_PREFIX)).toBe(true);
    expect(token).toHaveLength(PAT_PREFIX.length + 32);
    expect(token.slice(PAT_PREFIX.length)).toMatch(/^[0-9A-Za-z]{32}$/);
  });

  it('generates a different token every time and uses the whole base62 alphabet', () => {
    const tokens = Array.from({ length: 200 }, () => generateApiToken());
    expect(new Set(tokens).size).toBe(200);
    const body = tokens.join('').slice(0, 2000);
    expect(/[0-9]/.test(body)).toBe(true);
    expect(/[a-z]/.test(body)).toBe(true);
    expect(/[A-Z]/.test(body)).toBe(true);
  });

  it('takes the visible prefix from the random body, not from ejad_pat_', () => {
    const token = `${PAT_PREFIX}abcdefghIJKLMNOP0123456789abcdef`;
    expect(apiTokenPrefix(token)).toBe('abcdefgh');
  });

  it('hashes with SHA-256 and never contains the token', () => {
    const token = generateApiToken();
    const hash = hashApiToken(token);
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(token.slice(PAT_PREFIX.length));
  });

  it('accepts a matching hash and rejects a mismatch or a wrong length', () => {
    const hash = hashApiToken('ejad_pat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(verifyApiTokenHash(hash, hash)).toBe(true);
    expect(verifyApiTokenHash(hashApiToken('other'), hash)).toBe(false);
    expect(verifyApiTokenHash('deadbeef', hash)).toBe(false);
  });

  it('fails closed instead of throwing when a stored hash is the right length but not valid hex', () => {
    const hash = hashApiToken('ejad_pat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    // Same string length as a real hex hash (64 chars), but 'z' is not a hex digit, so decoding
    // it yields fewer than 32 bytes. This must return false, not throw a RangeError.
    const corrupt = 'z'.repeat(64);
    expect(hash).toHaveLength(64);
    expect(() => verifyApiTokenHash(hash, corrupt)).not.toThrow();
    expect(verifyApiTokenHash(hash, corrupt)).toBe(false);
  });

  it('recognises only PAT-shaped values, not JWTs', () => {
    expect(isApiTokenFormat(generateApiToken())).toBe(true);
    expect(isApiTokenFormat('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig')).toBe(false);
    expect(isApiTokenFormat('ejad_pat_short')).toBe(false);
    expect(isApiTokenFormat(`${PAT_PREFIX}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!!`)).toBe(false);
  });
});
