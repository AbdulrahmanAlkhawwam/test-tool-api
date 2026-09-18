import { Role } from '@prisma/client';
import { PASSWORD, seedUser } from './utils/factories';
import { createTestApp, resetDb, TestContext } from './utils/test-app';

function refreshCookie(res: { headers: Record<string, unknown> }): string {
  const cookies = res.headers['set-cookie'] as string[];
  return cookies.find((c) => c.startsWith('refresh_token='))!.split(';')[0];
}

describe('Auth (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('logs in (email is case-insensitive) and sets an httpOnly refresh cookie', async () => {
    await seedUser(ctx.prisma, { email: 'qa@ejad.test', name: 'QA', role: Role.TESTER });
    const res = await ctx.http().post('/api/auth/login').send({ email: 'QA@Ejad.test', password: PASSWORD }).expect(200);

    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user).toEqual({ id: expect.any(String), name: 'QA', email: 'qa@ejad.test', role: 'TESTER' });
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toMatch(/^refresh_token=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Path=\/api\/auth/);
  });

  it('rejects a wrong password with the uniform error body', async () => {
    await seedUser(ctx.prisma, { email: 'qa@ejad.test' });
    const res = await ctx.http().post('/api/auth/login').send({ email: 'qa@ejad.test', password: 'wrong-pass' }).expect(401);
    expect(res.body).toEqual({ statusCode: 401, error: 'Unauthorized', message: 'Invalid email or password' });
  });

  it('rejects an inactive user', async () => {
    await seedUser(ctx.prisma, { email: 'gone@ejad.test', active: false });
    await ctx.http().post('/api/auth/login').send({ email: 'gone@ejad.test', password: PASSWORD }).expect(401);
  });

  it('validates the login body', async () => {
    const res = await ctx.http().post('/api/auth/login').send({ password: PASSWORD }).expect(400);
    expect(res.body.message).toBe('Validation failed');
    expect(res.body.details).toEqual(expect.arrayContaining([expect.stringContaining('email')]));
  });

  it('protects routes without a token and returns the current user with one', async () => {
    const noToken = await ctx.http().get('/api/auth/me').expect(401);
    expect(noToken.body.message).toBe('Missing access token');

    await ctx.http().get('/api/auth/me').set('Authorization', 'Bearer not-a-jwt').expect(401);

    await seedUser(ctx.prisma, { email: 'qa@ejad.test', name: 'QA' });
    const login = await ctx.http().post('/api/auth/login').send({ email: 'qa@ejad.test', password: PASSWORD });
    const me = await ctx.http().get('/api/auth/me').set('Authorization', `Bearer ${login.body.accessToken}`).expect(200);
    expect(me.body).toEqual({ id: expect.any(String), name: 'QA', email: 'qa@ejad.test', role: 'TESTER' });
  });

  it('refreshes the access token from the cookie and rejects a missing cookie', async () => {
    await seedUser(ctx.prisma, { email: 'qa@ejad.test' });
    const login = await ctx.http().post('/api/auth/login').send({ email: 'qa@ejad.test', password: PASSWORD });

    const res = await ctx.http().post('/api/auth/refresh').set('Cookie', refreshCookie(login)).expect(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user.email).toBe('qa@ejad.test');

    await ctx.http().post('/api/auth/refresh').expect(401);
  });

  it('refresh fails once the user is deactivated', async () => {
    const user = await seedUser(ctx.prisma, { email: 'qa@ejad.test' });
    const login = await ctx.http().post('/api/auth/login').send({ email: 'qa@ejad.test', password: PASSWORD });
    await ctx.prisma.user.update({ where: { id: user.id }, data: { active: false } });
    await ctx.http().post('/api/auth/refresh').set('Cookie', refreshCookie(login)).expect(401);
  });

  it('logout clears the refresh cookie', async () => {
    const res = await ctx.http().post('/api/auth/logout').expect(204);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toMatch(/^refresh_token=;/);
  });
});
