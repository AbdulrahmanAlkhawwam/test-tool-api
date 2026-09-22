import { FakeGitlab, FakeUser } from './utils/fake-gitlab';
import { seedActors, seedProject } from './utils/factories';
import { createGitlabTestApp, SAMPLE_FILES, seedGitlabConnection } from './utils/gitlab';
import { resetDb, TestContext } from './utils/test-app';

describe('Repository link (e2e)', () => {
  let ctx: TestContext;
  let fake: FakeGitlab;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let projectId: string;
  let gitlabUser: FakeUser;

  beforeAll(async () => {
    ({ ctx, fake } = await createGitlabTestApp());
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    fake.reset();
    actors = await seedActors(ctx);
    ({ gitlabUser } = await seedGitlabConnection(ctx, fake, actors.admin.id, { username: 'admin' }));
    fake.addProject({ id: 101, path: 'mobile/ninja-store', members: [gitlabUser], files: SAMPLE_FILES });
    projectId = (await seedProject(ctx.prisma, actors.admin.id)).id;
  });
  afterAll(async () => {
    await ctx.app.close();
    await fake.close();
  });

  const url = () => `/api/projects/${projectId}/repository`;
  const link = (body: Record<string, unknown>) => ctx.http().put(url()).set(actors.adminAuth).send(body);

  it('links a repository, taking the default branch from GitLab', async () => {
    const res = await link({ gitlabProjectId: 101, testsPath: '/e2e/' }).expect(200);
    expect(res.body).toEqual({
      id: projectId,
      gitlabProjectId: 101,
      gitlabPath: 'mobile/ninja-store',
      gitlabWebUrl: `${fake.url}/mobile/ninja-store`,
      defaultBranch: 'main',
      testsPath: 'e2e',
      playwrightConfigPath: 'playwright.config.ts',
    });
    const project = await ctx.http().get('/api/projects/NINJA').set(actors.testerAuth).expect(200);
    expect(project.body).toMatchObject({ gitlabPath: 'mobile/ninja-store', gitlabWebUrl: `${fake.url}/mobile/ninja-store`, testsPath: 'e2e' });
  });

  it('validates the branch and the paths', async () => {
    const missingBranch = await link({ gitlabProjectId: 101, testsPath: 'e2e', defaultBranch: 'develop' }).expect(400);
    expect(missingBranch.body.message).toBe('Branch "develop" does not exist in mobile/ninja-store');

    fake.addBranch(101, 'develop');
    const ok = await link({ gitlabProjectId: 101, testsPath: 'e2e', defaultBranch: 'develop', playwrightConfigPath: 'config/pw.config.ts' }).expect(200);
    expect(ok.body).toMatchObject({ defaultBranch: 'develop', playwrightConfigPath: 'config/pw.config.ts' });

    const dots = await link({ gitlabProjectId: 101, testsPath: '../secrets' }).expect(400);
    expect(dots.body.message).toBe('Path must not contain "." or ".." segments');
    await link({ gitlabProjectId: 101 }).expect(400);
    await link({ gitlabProjectId: 101, testsPath: 'e2e', defaultBranch: 'bad branch' }).expect(400);
  });

  it("rejects a playwrightConfigPath with whitespace or shell metacharacters (it's spliced unquoted into the CI snippet)", async () => {
    for (const bad of ['config/pw config.ts', 'config/$(rm -rf /).ts', 'config/`whoami`.ts', "config/'; rm -rf /.ts", 'config/"x".ts']) {
      const res = await link({ gitlabProjectId: 101, testsPath: 'e2e', playwrightConfigPath: bad }).expect(400);
      expect(res.body.message).toBe('Validation failed');
      expect(res.body.details[0]).toContain("The Playwright config path can't contain spaces or special characters");
    }
  });

  it('lets only admins link or unlink', async () => {
    await ctx.http().put(url()).set(actors.testerAuth).send({ gitlabProjectId: 101, testsPath: 'e2e' }).expect(403);
    await ctx.http().delete(url()).set(actors.testerAuth).expect(403);
  });

  it("returns GitLab's 404 for projects the admin cannot access", async () => {
    const res = await link({ gitlabProjectId: 999, testsPath: 'e2e' }).expect(404);
    expect(res.body).toEqual({ statusCode: 404, error: 'Not Found', message: '404 Project Not Found', details: { source: 'gitlab' } });
  });

  it('refuses to link a GitLab project that has no default branch yet', async () => {
    fake.addEmptyProject({ id: 202, path: 'mobile/empty-repo', members: [gitlabUser] });
    const res = await link({ gitlabProjectId: 202, testsPath: 'e2e' }).expect(400);
    expect(res.body.message).toBe('mobile/empty-repo has no default branch yet – push a first commit');
  });

  it('unlinks the repository and keeps existing runs', async () => {
    await link({ gitlabProjectId: 101, testsPath: 'e2e' }).expect(200);
    await ctx.prisma.testRun.create({ data: { projectId, name: 'Old run', createdById: actors.admin.id } });

    await ctx.http().delete(url()).set(actors.adminAuth).expect(204);
    expect(await ctx.prisma.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      gitlabProjectId: null,
      gitlabPath: null,
      gitlabWebUrl: null,
      defaultBranch: null,
      testsPath: null,
      playwrightConfigPath: null,
    });
    expect(await ctx.prisma.testRun.count({ where: { projectId } })).toBe(1);
  });
});
