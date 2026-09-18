function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Environment variable ${name} is required`);
  return value;
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
  loginRateLimit: parseInt(process.env.LOGIN_RATE_LIMIT ?? '10', 10),
});
