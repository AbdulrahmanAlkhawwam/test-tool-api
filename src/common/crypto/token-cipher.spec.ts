import { TokenCipher, sha256Hex } from './token-cipher';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('TokenCipher', () => {
  it('round-trips a token', () => {
    const cipher = new TokenCipher(KEY);
    const encrypted = cipher.encrypt('glpat-secret-token');
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(encrypted).not.toContain('glpat-secret-token');
    expect(cipher.decrypt(encrypted)).toBe('glpat-secret-token');
  });

  it('uses a random IV for every encryption', () => {
    const cipher = new TokenCipher(KEY);
    const a = cipher.encrypt('same');
    const b = cipher.encrypt('same');
    expect(a).not.toBe(b);
    expect(cipher.decrypt(a)).toBe('same');
    expect(cipher.decrypt(b)).toBe('same');
  });

  it('rejects tampered ciphertext and a different key', () => {
    const cipher = new TokenCipher(KEY);
    const raw = Buffer.from(cipher.encrypt('token').slice(3), 'base64');
    raw[raw.length - 1] ^= 0xff;
    expect(() => cipher.decrypt(`v1:${raw.toString('base64')}`)).toThrow();
    const other = new TokenCipher(Buffer.alloc(32, 9).toString('base64'));
    expect(() => other.decrypt(cipher.encrypt('token'))).toThrow();
    expect(() => cipher.decrypt('plain-text')).toThrow('Unsupported encrypted token format');
  });

  it('requires a 32-byte key and hashes with SHA-256', () => {
    expect(() => new TokenCipher(Buffer.alloc(16).toString('base64'))).toThrow('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
