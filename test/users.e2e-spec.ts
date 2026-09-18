import { PASSWORD, seedActors } from './utils/factories';
import { createTestApp, resetDb, TestContext } from './utils/test-app';

describe('Users (e2e)', () => {
  let ctx: TestContext;
  let actors: Awaited<ReturnType<typeof seedActors>>;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    actors = await seedActors(ctx);
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('forbids testers from managing users', async () => {
    const res = await ctx.http().get('/api/users').set(actors.testerAuth).expect(403);
    expect(res.body.message).toBe('You do not have permission to perform this action');
    await ctx.http().post('/api/users').set(actors.testerAuth)
      .send({ name: 'X', email: 'x@ejad.test', password: 'Password1', role: 'TESTER' }).expect(403);
  });

  it('lists users without password hashes', async () => {
    const res = await ctx.http().get('/api/users').set(actors.adminAuth).expect(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toEqual({
      id: expect.any(String), name: 'Admin', email: 'admin@ejad.test', role: 'ADMIN', active: true, createdAt: expect.any(String),
    });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('creates a user who can then log in, and rejects duplicate emails', async () => {
    const created = await ctx.http().post('/api/users').set(actors.adminAuth)
      .send({ name: 'Ahmed', email: 'Ahmed@Ejad.test', password: 'Password1', role: 'TESTER' }).expect(201);
    expect(created.body).toMatchObject({ name: 'Ahmed', email: 'ahmed@ejad.test', role: 'TESTER', active: true });

    await ctx.http().post('/api/auth/login').send({ email: 'ahmed@ejad.test', password: 'Password1' }).expect(200);

    const dup = await ctx.http().post('/api/users').set(actors.adminAuth)
      .send({ name: 'Ahmed 2', email: 'ahmed@ejad.test', password: 'Password1', role: 'TESTER' }).expect(409);
    expect(dup.body.message).toBe('A user with this email already exists');
  });

  it('validates the create body', async () => {
    const res = await ctx.http().post('/api/users').set(actors.adminAuth)
      .send({ name: '', email: 'bad', password: 'short', role: 'OWNER' }).expect(400);
    expect(res.body.details.length).toBeGreaterThanOrEqual(4);
  });

  it('deactivating a user immediately invalidates their token', async () => {
    await ctx.http().patch(`/api/users/${actors.tester.id}`).set(actors.adminAuth).send({ active: false }).expect(200);
    const res = await ctx.http().get('/api/auth/me').set(actors.testerAuth).expect(401);
    expect(res.body.message).toBe('User is inactive');
  });

  it('changes role and resets password', async () => {
    const res = await ctx.http().patch(`/api/users/${actors.tester.id}`).set(actors.adminAuth)
      .send({ role: 'ADMIN', password: 'NewPassword1' }).expect(200);
    expect(res.body.role).toBe('ADMIN');
    await ctx.http().post('/api/auth/login').send({ email: 'tester@ejad.test', password: 'NewPassword1' }).expect(200);
  });

  it('prevents admins from deactivating or demoting themselves', async () => {
    const res = await ctx.http().patch(`/api/users/${actors.admin.id}`).set(actors.adminAuth).send({ active: false }).expect(400);
    expect(res.body.message).toBe('You cannot deactivate or demote your own account');
    await ctx.http().patch(`/api/users/${actors.admin.id}`).set(actors.adminAuth).send({ role: 'TESTER' }).expect(400);
  });

  it('rejects null for required user fields', async () => {
    for (const field of ['name', 'role', 'active', 'password']) {
      await ctx.http().patch(`/api/users/${actors.tester.id}`).set(actors.adminAuth).send({ [field]: null }).expect(400);
    }
  });

  it('returns 404 for an unknown user', async () => {
    await ctx.http().patch('/api/users/7a1d0c5e-0000-4000-8000-000000000000').set(actors.adminAuth).send({ name: 'Xx' }).expect(404);
  });

  it('lets any user change their own password', async () => {
    const wrong = await ctx.http().patch('/api/users/me/password').set(actors.testerAuth)
      .send({ currentPassword: 'nope', newPassword: 'Another123' }).expect(400);
    expect(wrong.body.message).toBe('Current password is incorrect');

    await ctx.http().patch('/api/users/me/password').set(actors.testerAuth)
      .send({ currentPassword: PASSWORD, newPassword: 'Another123' }).expect(204);
    await ctx.http().post('/api/auth/login').send({ email: 'tester@ejad.test', password: 'Another123' }).expect(200);
  });
});
