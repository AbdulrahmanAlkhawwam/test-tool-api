import { createTestApp, TestContext } from './utils/test-app';

describe('Health (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('GET /api/health reports ok with a live database', async () => {
    const res = await ctx.http().get('/api/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('does not trust proxies unless TRUST_PROXY is set', () => {
    expect(ctx.app.getHttpAdapter().getInstance().get('trust proxy')).toBeFalsy();
  });

  it('applies TRUST_PROXY hops to Express', async () => {
    process.env.TRUST_PROXY = '1';
    const proxied = await createTestApp();
    try {
      expect(proxied.app.getHttpAdapter().getInstance().get('trust proxy')).toBe(1);
    } finally {
      delete process.env.TRUST_PROXY;
      await proxied.app.close();
    }
  });

  it('answers the standard JSON error shape (not Express’s HTML page) for a body over the size limit', async () => {
    const res = await ctx
      .http()
      .post('/api/auth/login')
      .send({ email: 'a@b.com', password: 'x'.repeat(3 * 1024 * 1024) });
    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({ statusCode: 413, error: 'Payload Too Large', message: 'Request body is too large' });
  });
});
