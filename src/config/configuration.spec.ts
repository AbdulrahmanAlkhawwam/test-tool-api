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
      pollIntervalMs: 20_000,
      runTimeoutMs: 7_200_000,
      requestTimeoutMs: 15_000,
    });
  });

  it('reads an enabled configuration and trims trailing slashes', () => {
    const config = parseGitlabConfig({
      GITLAB_URL: 'https://git.ejad.net/',
      GITLAB_OAUTH_CLIENT_ID: 'id',
      GITLAB_OAUTH_CLIENT_SECRET: 'secret',
      GITLAB_OAUTH_REDIRECT_URI: 'https://api.test/api/gitlab/oauth/callback',
      TOKEN_ENCRYPTION_KEY: KEY,
      GITLAB_POLL_INTERVAL_MS: '5000',
      GITLAB_RUN_TIMEOUT_MINUTES: '30',
      GITLAB_REQUEST_TIMEOUT_MS: '5000',
    });
    expect(config).toMatchObject({
      enabled: true,
      url: 'https://git.ejad.net',
      pollIntervalMs: 5000,
      runTimeoutMs: 1_800_000,
      requestTimeoutMs: 5000,
    });
  });

  it('falls back to the defaults for an unparsable or non-positive poll interval / run timeout', () => {
    const base = {
      GITLAB_URL: 'https://git.ejad.net',
      GITLAB_OAUTH_CLIENT_ID: 'id',
      GITLAB_OAUTH_CLIENT_SECRET: 'secret',
      GITLAB_OAUTH_REDIRECT_URI: 'https://api.test/cb',
      TOKEN_ENCRYPTION_KEY: KEY,
    };
    // 0 is kept for the poll interval (it means "off"), but a negative or non-numeric value isn't.
    expect(parseGitlabConfig({ ...base, GITLAB_POLL_INTERVAL_MS: '0' })).toMatchObject({ pollIntervalMs: 0 });
    expect(parseGitlabConfig({ ...base, GITLAB_POLL_INTERVAL_MS: 'abc' })).toMatchObject({ pollIntervalMs: 20_000 });
    expect(parseGitlabConfig({ ...base, GITLAB_POLL_INTERVAL_MS: '-5' })).toMatchObject({ pollIntervalMs: 20_000 });
    // There is no "off" for the run timeout, so 0 falls back too.
    expect(parseGitlabConfig({ ...base, GITLAB_RUN_TIMEOUT_MINUTES: '0' })).toMatchObject({ runTimeoutMs: 7_200_000 });
    expect(parseGitlabConfig({ ...base, GITLAB_RUN_TIMEOUT_MINUTES: 'abc' })).toMatchObject({ runTimeoutMs: 7_200_000 });
    expect(parseGitlabConfig({ ...base, GITLAB_RUN_TIMEOUT_MINUTES: '-30' })).toMatchObject({ runTimeoutMs: 7_200_000 });
    expect(parseGitlabConfig({ ...base, GITLAB_RUN_TIMEOUT_MINUTES: '30' })).toMatchObject({ runTimeoutMs: 1_800_000 });
  });

  it('bounds the poll interval to [1s, 1h] (0 is still always "off")', () => {
    const base = {
      GITLAB_URL: 'https://git.ejad.net',
      GITLAB_OAUTH_CLIENT_ID: 'id',
      GITLAB_OAUTH_CLIENT_SECRET: 'secret',
      GITLAB_OAUTH_REDIRECT_URI: 'https://api.test/cb',
      TOKEN_ENCRYPTION_KEY: KEY,
    };
    expect(parseGitlabConfig({ ...base, GITLAB_POLL_INTERVAL_MS: '0' })).toMatchObject({ pollIntervalMs: 0 });
    expect(parseGitlabConfig({ ...base, GITLAB_POLL_INTERVAL_MS: '1000' })).toMatchObject({ pollIntervalMs: 1000 });
    expect(parseGitlabConfig({ ...base, GITLAB_POLL_INTERVAL_MS: '3600000' })).toMatchObject({ pollIntervalMs: 3_600_000 });
    // Below the minimum, above the maximum: both fall back to the default, not clamp to the bound.
    expect(parseGitlabConfig({ ...base, GITLAB_POLL_INTERVAL_MS: '500' })).toMatchObject({ pollIntervalMs: 20_000 });
    expect(parseGitlabConfig({ ...base, GITLAB_POLL_INTERVAL_MS: '3600001' })).toMatchObject({ pollIntervalMs: 20_000 });
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
