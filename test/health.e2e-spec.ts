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
});
