import { seedActors, seedCase, seedModule, seedProject } from './utils/factories';
import { createTestApp, resetDb, TestContext } from './utils/test-app';

describe('Modules (e2e)', () => {
  let ctx: TestContext;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let projectId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    actors = await seedActors(ctx);
    projectId = (await seedProject(ctx.prisma, actors.admin.id)).id;
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('testers create modules; the code is uppercased and unique per project', async () => {
    const res = await ctx.http().post(`/api/projects/${projectId}/modules`).set(actors.testerAuth)
      .send({ name: 'Authentication', code: 'auth' }).expect(201);
    expect(res.body).toMatchObject({ name: 'Authentication', code: 'AUTH', projectId });

    const dup = await ctx.http().post(`/api/projects/${projectId}/modules`).set(actors.testerAuth)
      .send({ name: 'Auth again', code: 'AUTH' }).expect(409);
    expect(dup.body.message).toBe('Module code "AUTH" already exists in this project');

    const other = await seedProject(ctx.prisma, actors.admin.id, { key: 'DINAR' });
    await ctx.http().post(`/api/projects/${other.id}/modules`).set(actors.testerAuth)
      .send({ name: 'Authentication', code: 'AUTH' }).expect(201);
  });

  it('validates the code format and the project', async () => {
    await ctx.http().post(`/api/projects/${projectId}/modules`).set(actors.testerAuth)
      .send({ name: 'Bad', code: 'A-1' }).expect(400);
    await ctx.http().post('/api/projects/7a1d0c5e-0000-4000-8000-000000000000/modules').set(actors.testerAuth)
      .send({ name: 'X', code: 'X' }).expect(404);
  });

  it('lists modules with case counts, ordered by code', async () => {
    const auth = await seedModule(ctx.prisma, projectId, { code: 'AUTH', name: 'Authentication' });
    await seedModule(ctx.prisma, projectId, { code: 'CART', name: 'Cart' });
    await seedCase(ctx.prisma, { projectId, moduleId: auth.id, userId: actors.admin.id, code: 'TC-AUTH-001' });

    const res = await ctx.http().get(`/api/projects/${projectId}/modules`).set(actors.testerAuth).expect(200);
    expect(res.body).toEqual([
      { id: auth.id, name: 'Authentication', code: 'AUTH', caseCount: 1 },
      { id: expect.any(String), name: 'Cart', code: 'CART', caseCount: 0 },
    ]);
  });

  it('renames a module and rejects a code clash', async () => {
    const auth = await seedModule(ctx.prisma, projectId, { code: 'AUTH' });
    await seedModule(ctx.prisma, projectId, { code: 'CART', name: 'Cart' });
    const res = await ctx.http().patch(`/api/modules/${auth.id}`).set(actors.testerAuth).send({ name: 'Login & Register' }).expect(200);
    expect(res.body.name).toBe('Login & Register');
    await ctx.http().patch(`/api/modules/${auth.id}`).set(actors.testerAuth).send({ code: 'CART' }).expect(409);
  });

  it('deletes only modules without test cases', async () => {
    const auth = await seedModule(ctx.prisma, projectId, { code: 'AUTH' });
    const cart = await seedModule(ctx.prisma, projectId, { code: 'CART', name: 'Cart' });
    await seedCase(ctx.prisma, { projectId, moduleId: auth.id, userId: actors.admin.id, code: 'TC-AUTH-001' });

    const blocked = await ctx.http().delete(`/api/modules/${auth.id}`).set(actors.testerAuth).expect(409);
    expect(blocked.body.message).toBe('Only modules without test cases can be deleted');
    await ctx.http().delete(`/api/modules/${cart.id}`).set(actors.testerAuth).expect(204);
    await ctx.http().delete(`/api/modules/${cart.id}`).set(actors.testerAuth).expect(404);
  });
});
