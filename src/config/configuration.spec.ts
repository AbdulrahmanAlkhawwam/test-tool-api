import { parseGitlabConfig, parseTrustProxy } from './configuration';

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

describe('parseGitlabConfig', () => {
  const KEY = Buffer.alloc(32, 1).toString('base64');

  it('is disabled when GITLAB_URL is unset, with defaults', () => {
    expect(parseGitlabConfig({})).toEqual({
      enabled: false,
      url: '',
      clientId: '',
      clientSecret: '',
      redirectUri: '',
      tokenEncryptionKey: '',
      webUrl: 'http://localhost:3001',
      pollIntervalMs: 20_000,
      runTimeoutMs: 7_200_000,
    });
  });

  it('reads an enabled configuration and trims trailing slashes', () => {
    const config = parseGitlabConfig({
      GITLAB_URL: 'https://git.ejad.net/',
      GITLAB_OAUTH_CLIENT_ID: 'id',
      GITLAB_OAUTH_CLIENT_SECRET: 'secret',
      GITLAB_OAUTH_REDIRECT_URI: 'https://api.test/api/gitlab/oauth/callback',
      TOKEN_ENCRYPTION_KEY: KEY,
      WEB_URL: 'https://tests.ejad.net/',
      GITLAB_POLL_INTERVAL_MS: '5000',
      GITLAB_RUN_TIMEOUT_MINUTES: '30',
    });
    expect(config).toMatchObject({
      enabled: true,
      url: 'https://git.ejad.net',
      webUrl: 'https://tests.ejad.net',
      pollIntervalMs: 5000,
      runTimeoutMs: 1_800_000,
    });
  });

  it('fails fast on missing OAuth settings or a bad encryption key', () => {
    expect(() => parseGitlabConfig({ GITLAB_URL: 'https://git.ejad.net' })).toThrow(
      'GITLAB_URL is set, so these variables are required too: GITLAB_OAUTH_CLIENT_ID, GITLAB_OAUTH_CLIENT_SECRET, GITLAB_OAUTH_REDIRECT_URI, TOKEN_ENCRYPTION_KEY',
    );
    expect(() =>
      parseGitlabConfig({
        GITLAB_URL: 'https://git.ejad.net',
        GITLAB_OAUTH_CLIENT_ID: 'id',
        GITLAB_OAUTH_CLIENT_SECRET: 'secret',
        GITLAB_OAUTH_REDIRECT_URI: 'https://api.test/cb',
        TOKEN_ENCRYPTION_KEY: 'c2hvcnQ=',
      }),
    ).toThrow('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  });
});
