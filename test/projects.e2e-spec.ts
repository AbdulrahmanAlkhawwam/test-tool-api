import { seedActors, seedCase, seedModule, seedProject } from './utils/factories';
import { createTestApp, resetDb, TestContext } from './utils/test-app';

describe('Projects (e2e)', () => {
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

  it('lets admins create projects and uppercases the key', async () => {
    const res = await ctx.http().post('/api/projects').set(actors.adminAuth)
      .send({ name: 'Ninja Store', key: 'ninja', description: 'E-commerce' }).expect(201);
    expect(res.body).toMatchObject({ name: 'Ninja Store', key: 'NINJA', description: 'E-commerce', archivedAt: null });
  });

  it('forbids testers from creating or editing projects', async () => {
    await ctx.http().post('/api/projects').set(actors.testerAuth).send({ name: 'X', key: 'XX' }).expect(403);
    const p = await seedProject(ctx.prisma, actors.admin.id);
    await ctx.http().patch(`/api/projects/${p.id}`).set(actors.testerAuth).send({ name: 'Y' }).expect(403);
  });

  it('rejects invalid and duplicate keys', async () => {
    const bad = await ctx.http().post('/api/projects').set(actors.adminAuth).send({ name: 'Valid Name', key: '1-bad' }).expect(400);
    expect(bad.body.details[0]).toContain('key must be 2–10 uppercase letters/digits');
    await seedProject(ctx.prisma, actors.admin.id, { key: 'NINJA' });
    const dup = await ctx.http().post('/api/projects').set(actors.adminAuth).send({ name: 'Other', key: 'NINJA' }).expect(409);
    expect(dup.body.message).toBe('Project key "NINJA" is already used');
  });

  it('lists active projects with case counts that ignore deleted cases', async () => {
    const p = await seedProject(ctx.prisma, actors.admin.id, { key: 'NINJA', name: 'Ninja Store' });
    await seedProject(ctx.prisma, actors.admin.id, { key: 'DINAR', name: 'Dinar' });
    const m = await seedModule(ctx.prisma, p.id);
    await seedCase(ctx.prisma, { projectId: p.id, moduleId: m.id, userId: actors.admin.id, code: 'TC-AUTH-001' });
    const deleted = await seedCase(ctx.prisma, { projectId: p.id, moduleId: m.id, userId: actors.admin.id, code: 'TC-AUTH-002' });
    await ctx.prisma.testCase.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });

    const res = await ctx.http().get('/api/projects').set(actors.testerAuth).expect(200);
    expect(res.body.map((x: { key: string }) => x.key)).toEqual(['DINAR', 'NINJA']);
    expect(res.body.find((x: { key: string }) => x.key === 'NINJA').caseCount).toBe(1);
  });

  it('archives projects, hiding them unless includeArchived=true', async () => {
    const p = await seedProject(ctx.prisma, actors.admin.id);
    const res = await ctx.http().patch(`/api/projects/${p.id}`).set(actors.adminAuth).send({ archived: true }).expect(200);
    expect(res.body.archivedAt).not.toBeNull();

    expect((await ctx.http().get('/api/projects').set(actors.adminAuth)).body).toHaveLength(0);
    expect((await ctx.http().get('/api/projects?includeArchived=true').set(actors.adminAuth)).body).toHaveLength(1);

    await ctx.http().patch(`/api/projects/${p.id}`).set(actors.adminAuth).send({ archived: false }).expect(200);
    expect((await ctx.http().get('/api/projects').set(actors.adminAuth)).body).toHaveLength(1);
  });

  it('rejects null for required fields and lets null clear the description', async () => {
    const p = await seedProject(ctx.prisma, actors.admin.id);
    await ctx.http().patch(`/api/projects/${p.id}`).set(actors.adminAuth).send({ name: null }).expect(400);
    await ctx.http().patch(`/api/projects/${p.id}`).set(actors.adminAuth).send({ archived: null }).expect(400);
    await ctx.http().patch(`/api/projects/${p.id}`).set(actors.adminAuth).send({ description: 'Shop' }).expect(200);
    const res = await ctx.http().patch(`/api/projects/${p.id}`).set(actors.adminAuth).send({ description: null }).expect(200);
    expect(res.body).toMatchObject({ name: 'Ninja Store', description: null });
  });

  it('gets a project by key (any case) with its modules', async () => {
    const p = await seedProject(ctx.prisma, actors.admin.id);
    const m = await seedModule(ctx.prisma, p.id, { code: 'AUTH', name: 'Authentication' });
    await seedCase(ctx.prisma, { projectId: p.id, moduleId: m.id, userId: actors.admin.id, code: 'TC-AUTH-001' });

    const res = await ctx.http().get('/api/projects/ninja').set(actors.testerAuth).expect(200);
    expect(res.body).toMatchObject({ id: p.id, key: 'NINJA' });
    expect(res.body.modules).toEqual([{ id: m.id, name: 'Authentication', code: 'AUTH', caseCount: 1 }]);

    const missing = await ctx.http().get('/api/projects/NOPE').set(actors.testerAuth).expect(404);
    expect(missing.body.message).toBe('Project not found');
  });
});
