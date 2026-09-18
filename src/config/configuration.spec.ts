import { parseTrustProxy } from './configuration';

describe('parseTrustProxy', () => {
  it('leaves trust proxy unset when TRUST_PROXY is missing or blank', () => {
    expect(parseTrustProxy(undefined)).toBeUndefined();
    expect(parseTrustProxy('  ')).toBeUndefined();
  });

  it('parses booleans and hop counts', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy(' 2 ')).toBe(2);
  });

  it('passes other Express values through', () => {
    expect(parseTrustProxy('loopback')).toBe('loopback');
  });
});
