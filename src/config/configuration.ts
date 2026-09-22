function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Environment variable ${name} is required`);
  return value;
}

/**
 * Express "trust proxy" setting from TRUST_PROXY: unset → undefined (not applied, Express
 * default false); "true"/"false" → boolean; a number → hop count (e.g. 1 behind Traefik);
 * anything else (e.g. "loopback" or a subnet list) is passed through as-is.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return value;
}

export interface GitlabConfig {
  /** false when GITLAB_URL is unset: every GitLab endpoint then answers 404. */
  enabled: boolean;
  url: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenEncryptionKey: string;
  /** Where the OAuth callback sends the browser back to. */
  webUrl: string;
  /** Pipeline poller interval; 0 disables the interval (tests call pollOnce directly). */
  pollIntervalMs: number;
  /** Automated runs still unfinished after this long are closed. */
  runTimeoutMs: number;
}

const stripSlash = (value: string) => value.trim().replace(/\/+$/, '');

/**
 * Parses a non-negative integer from an env var, falling back to `fallback` when the value is
 * missing, not a number, or negative. `zeroMeans`, when given, is what `0` itself means (e.g. the
 * poll interval's "off" switch) so a caller can tell that apart from an unparsable value; without
 * it, `0` also falls back to `fallback` (there is no meaningful "off" for a timeout).
 */
function parseNonNegativeInt(raw: string | undefined, fallback: number, allowZero = false): number {
  if (raw === undefined) return fallback;
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) return fallback;
  if (value === 0 && !allowZero) return fallback;
  return value;
}

export function parseGitlabConfig(env: NodeJS.ProcessEnv): GitlabConfig {
  const url = stripSlash(env.GITLAB_URL ?? '');
  const config: GitlabConfig = {
    enabled: url !== '',
    url,
    clientId: env.GITLAB_OAUTH_CLIENT_ID ?? '',
    clientSecret: env.GITLAB_OAUTH_CLIENT_SECRET ?? '',
    redirectUri: env.GITLAB_OAUTH_REDIRECT_URI ?? '',
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY ?? '',
    webUrl: stripSlash(env.WEB_URL ?? 'http://localhost:3001'),
    // 0 is a meaningful, valid value here: it turns the pipeline poller off (tests rely on this).
    pollIntervalMs: parseNonNegativeInt(env.GITLAB_POLL_INTERVAL_MS, 20_000, true),
    runTimeoutMs: parseNonNegativeInt(env.GITLAB_RUN_TIMEOUT_MINUTES, 120) * 60_000,
  };
  if (config.enabled) {
    const missing = (
      [
        ['GITLAB_OAUTH_CLIENT_ID', config.clientId],
        ['GITLAB_OAUTH_CLIENT_SECRET', config.clientSecret],
        ['GITLAB_OAUTH_REDIRECT_URI', config.redirectUri],
        ['TOKEN_ENCRYPTION_KEY', config.tokenEncryptionKey],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length) throw new Error(`GITLAB_URL is set, so these variables are required too: ${missing.join(', ')}`);
    if (Buffer.from(config.tokenEncryptionKey, 'base64').length !== 32) {
      throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
    }
  }
  return config;
}

export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  corsOrigins: (process.env.CORS_ORIGIN ?? 'http://localhost:3001').split(',').map((o) => o.trim()),
  jwt: {
    accessSecret: required('JWT_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtlDays: parseInt(process.env.JWT_REFRESH_TTL_DAYS ?? '7', 10),
  },
  cookie: {
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: (process.env.COOKIE_SAMESITE ?? 'lax') as 'lax' | 'strict' | 'none',
  },
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  loginRateLimit: parseInt(process.env.LOGIN_RATE_LIMIT ?? '10', 10),
  gitlab: parseGitlabConfig(process.env),
});
