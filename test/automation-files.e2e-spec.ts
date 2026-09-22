import { FakeGitlab } from './utils/fake-gitlab';
import { seedActors } from './utils/factories';
import { createGitlabTestApp, GITLAB_PROJECT_ID as P, LOGIN_SPEC, seedGitlabConnection, seedLinkedProject, waitForRequests } from './utils/gitlab';
import { resetDb, TestContext } from './utils/test-app';

const LOGIN = 'e2e/auth/login.spec.ts';
const WORK_BRANCH = 'tests/tess/login-fixes';

describe('Automation files (e2e)', () => {
  let ctx: TestContext;
  let fake: FakeGitlab;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let projectId: string;
  let tessToken: string;

  beforeAll(async () => {
    ({ ctx, fake } = await createGitlabTestApp());
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    fake.reset();
    actors = await seedActors(ctx);
    const tess = await seedGitlabConnection(ctx, fake, actors.tester.id, { username: 'tess' });
    tessToken = tess.accessToken;
    projectId = (await seedLinkedProject(ctx, fake, actors.admin.id, [tess.gitlabUser])).project.id;
  });
  afterAll(async () => {
    await ctx.app.close();
    await fake.close();
  });

  const base = () => `/api/projects/${projectId}/automation`;
  const save = (body: Record<string, unknown>) => ctx.http().put(`${base()}/file`).set(actors.testerAuth).send(body);
  const mainCommit = (path: string) => fake.file(P, 'main', path)!.lastCommitId;

  it('lists the tests folder of the default branch with the user token', async () => {
    const res = await ctx.http().get(`${base()}/tree`).set(actors.testerAuth).expect(200);
    expect(res.body).toEqual({
      ref: 'main',
      testsPath: 'e2e',
      entries: [
        { path: 'e2e/auth', name: 'auth', type: 'tree' },
        { path: 'e2e/auth/login.spec.ts', name: 'login.spec.ts', type: 'blob' },
        { path: 'e2e/cart', name: 'cart', type: 'tree' },
        { path: 'e2e/cart/cart.spec.ts', name: 'cart.spec.ts', type: 'blob' },
        { path: 'e2e/fixtures', name: 'fixtures', type: 'tree' },
        { path: 'e2e/fixtures/users.ts', name: 'users.ts', type: 'blob' },
      ],
    });
    expect(fake.requestsTo('/repository/tree')[0].token).toBe(tessToken);
  });

  it('reads a file with its last commit id', async () => {
    const res = await ctx.http().get(`${base()}/file`).query({ path: LOGIN }).set(actors.testerAuth).expect(200);
    expect(res.body).toEqual({
      path: LOGIN,
      ref: 'main',
      content: LOGIN_SPEC,
      lastCommitId: mainCommit(LOGIN),
      size: Buffer.byteLength(LOGIN_SPEC),
      readOnly: false,
    });
    const missing = await ctx.http().get(`${base()}/file`).query({ path: 'e2e/nope.spec.ts' }).set(actors.testerAuth).expect(404);
    expect(missing.body.message).toBe('File "e2e/nope.spec.ts" was not found on main');
  });

  it('rejects paths outside the tests folder and non-code files', async () => {
    const outside = await ctx.http().get(`${base()}/file`).query({ path: 'src/app.ts' }).set(actors.testerAuth).expect(400);
    expect(outside.body.message).toBe('Path must be inside the tests folder "e2e"');
    const dots = await save({ path: '../src/app.ts', content: 'x', branchSlug: 'hack' }).expect(400);
    expect(dots.body.message).toBe('Path must not contain "." or ".." segments');
    const markdown = await save({ path: 'e2e/notes.md', content: 'x', branchSlug: 'notes' }).expect(400);
    expect(markdown.body.message).toBe('Only .ts and .js files can be edited (for example login.spec.ts)');
    expect(fake.requestsTo('/repository/commits')).toHaveLength(0);
  });

  it('creates the work branch from the default branch and opens a merge request on first save', async () => {
    const content = LOGIN_SPEC.replace('@TC-AUTH-001', '@TC-AUTH-001 @TC-AUTH-003');
    const res = await save({ path: LOGIN, content, lastCommitId: mainCommit(LOGIN), branchSlug: 'Login fixes' }).expect(200);
    expect(res.body).toEqual({
      branch: WORK_BRANCH,
      commitId: fake.branch(P, WORK_BRANCH)!.commitId,
      mergeRequest: { iid: 1, webUrl: `${fake.url}/mobile/ninja-store/-/merge_requests/1`, state: 'opened' },
    });
    expect(fake.file(P, WORK_BRANCH, LOGIN)!.content).toBe(content);
    expect(fake.file(P, 'main', LOGIN)!.content).toBe(LOGIN_SPEC);

    const [commit] = fake.requestsTo('/repository/commits');
    expect(commit.token).toBe(tessToken);
    expect(commit.body).toMatchObject({ branch: WORK_BRANCH, start_branch: 'main' });
    expect(fake.mergeRequests).toHaveLength(1);
    expect(fake.mergeRequests[0]).toMatchObject({ source_branch: WORK_BRANCH, target_branch: 'main', title: 'Tests: Login fixes' });
    expect(fake.mergeRequests[0].description).toContain('- `e2e/auth/login.spec.ts`');
    expect(fake.mergeRequests[0].description).toContain('- TC-AUTH-003');
  });

  it('reuses the work branch and updates the same merge request', async () => {
    await save({ path: LOGIN, content: LOGIN_SPEC, lastCommitId: mainCommit(LOGIN), branchSlug: 'Login fixes' }).expect(200);
    const second = await save({
      path: 'e2e/auth/logout.spec.ts',
      content: "test('logs out @TC-AUTH-004', async () => {});\n",
      branchSlug: 'Login fixes',
    }).expect(200);
    expect(second.body).toMatchObject({ branch: WORK_BRANCH, mergeRequest: { iid: 1, state: 'opened' } });

    expect(fake.mergeRequests).toHaveLength(1);
    expect(fake.mergeRequests[0].description).toContain('- `e2e/auth/login.spec.ts`\n- `e2e/auth/logout.spec.ts`');
    expect(fake.mergeRequests[0].description).toContain('- TC-AUTH-004');
    const commits = fake.requestsTo('/repository/commits');
    expect(commits[1].body).not.toHaveProperty('start_branch');
    expect(commits.every((c) => (c.body as { branch: string }).branch !== 'main')).toBe(true);
  });

  it('returns 409 when the file changed on the branch since it was opened', async () => {
    const opened = mainCommit(LOGIN);
    await save({ path: LOGIN, content: 'first', lastCommitId: opened, branchSlug: 'Login fixes' }).expect(200);
    fake.setFile(P, WORK_BRANCH, LOGIN, 'pushed from a laptop');

    const stale = await save({ path: LOGIN, content: 'second', lastCommitId: opened, branchSlug: 'Login fixes' }).expect(409);
    expect(stale.body.message).toBe('This file changed on the branch – reload it before saving');
    const exists = await save({ path: 'e2e/cart/cart.spec.ts', content: 'x', branchSlug: 'Login fixes' }).expect(409);
    expect(exists.body.message).toBe('A file with this path already exists – open it before saving');
    expect(fake.file(P, WORK_BRANCH, LOGIN)!.content).toBe('pushed from a laptop');
  });

  it("lists the default branch and the user's work branches with their merge requests", async () => {
    await save({ path: LOGIN, content: 'x', lastCommitId: mainCommit(LOGIN), branchSlug: 'Login fixes' }).expect(200);
    fake.addBranch(P, 'tests/other-cart');
    fake.addBranch(P, 'feature/x');

    const res = await ctx.http().get(`${base()}/branches`).set(actors.testerAuth).expect(200);
    expect(res.body).toEqual({
      defaultBranch: 'main',
      branches: [
        { name: 'main', isDefault: true, mergeRequest: null },
        {
          name: WORK_BRANCH,
          isDefault: false,
          mergeRequest: { iid: 1, webUrl: `${fake.url}/mobile/ninja-store/-/merge_requests/1`, state: 'opened' },
        },
      ],
    });
  });

  it('opens files over 1 MB read-only and refuses to save them', async () => {
    const big = `// ${'x'.repeat(1024 * 1024)}\n`;
    fake.setFile(P, 'main', 'e2e/big.spec.ts', big);
    const res = await ctx.http().get(`${base()}/file`).query({ path: 'e2e/big.spec.ts' }).set(actors.testerAuth).expect(200);
    expect(res.body).toMatchObject({ readOnly: true, size: Buffer.byteLength(big) });
    const tooBig = await save({ path: 'e2e/big.spec.ts', content: big, lastCommitId: res.body.lastCommitId, branchSlug: 'big' }).expect(413);
    expect(tooBig.body.message).toBe('Files larger than 1 MB are read-only');
  });

  it('refuses to open files over 5 MB without ever downloading their content', async () => {
    const huge = `// ${'x'.repeat(6 * 1024 * 1024)}\n`;
    fake.setFile(P, 'main', 'e2e/huge.spec.ts', huge);
    const res = await ctx.http().get(`${base()}/file`).query({ path: 'e2e/huge.spec.ts' }).set(actors.testerAuth).expect(413);
    expect(res.body.message).toBe("Files larger than 5 MB can't be opened here");
    expect(fake.requestsTo('/repository/files', 'HEAD')).toHaveLength(1);
    expect(fake.requestsTo('/repository/files', 'GET')).toHaveLength(0);
  });

  it('opens a non-UTF-8 file read-only instead of returning lossy content as editable', async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]);
    fake.setBinaryFile(P, 'main', 'e2e/fixture.spec.ts', binary);
    const res = await ctx.http().get(`${base()}/file`).query({ path: 'e2e/fixture.spec.ts' }).set(actors.testerAuth).expect(200);
    expect(res.body.readOnly).toBe(true);

    const attempt = await save({
      path: 'e2e/fixture.spec.ts',
      content: 'replacement',
      lastCommitId: res.body.lastCommitId,
      branchSlug: 'fix',
    }).expect(400);
    expect(attempt.body.message).toBe("This file isn't UTF-8 text and can't be edited here");
  });

  it('opens a non-.ts/.js file read-only regardless of its content', async () => {
    fake.setFile(P, 'main', 'e2e/notes.md', '# notes\n');
    const res = await ctx.http().get(`${base()}/file`).query({ path: 'e2e/notes.md' }).set(actors.testerAuth).expect(200);
    expect(res.body).toMatchObject({ readOnly: true });
  });

  it('reuses the merge request a concurrent request just created (409 on create)', async () => {
    fake.forceNextMergeRequestCreateConflict();
    const res = await save({ path: LOGIN, content: 'x', lastCommitId: mainCommit(LOGIN), branchSlug: 'Login fixes' }).expect(200);
    expect(res.body.branch).toBe(WORK_BRANCH);
    expect(res.body.mergeRequest).toMatchObject({ state: 'opened' });
    // Exactly one MR exists: the create wasn't retried into a duplicate after the 409.
    expect(fake.mergeRequests).toHaveLength(1);
    expect(fake.mergeRequests[0]).toMatchObject({ source_branch: WORK_BRANCH, state: 'opened' });
    expect(fake.mergeRequests[0].description).toContain('- `e2e/auth/login.spec.ts`');
  });

  it('still returns 200 with mergeRequest: null when the merge request step keeps failing after a successful commit', async () => {
    fake.breakNextMergeRequestList();
    const res = await save({ path: LOGIN, content: 'x', lastCommitId: mainCommit(LOGIN), branchSlug: 'Login fixes' }).expect(200);
    expect(res.body).toMatchObject({ branch: WORK_BRANCH, mergeRequest: null });
    expect(res.body.commitId).toBe(fake.branch(P, WORK_BRANCH)!.commitId);
    expect(fake.file(P, WORK_BRANCH, LOGIN)!.content).toBe('x');
  });

  it('returns 409 when GitLab itself rejects a stale last_commit_id after our own pre-check passed', async () => {
    await save({ path: LOGIN, content: 'first', lastCommitId: mainCommit(LOGIN), branchSlug: 'Login fixes' }).expect(200);
    const readLastCommitId = fake.file(P, WORK_BRANCH, LOGIN)!.lastCommitId;

    const release = fake.holdCommitRequests();
    // `.then()` (not a bare assignment) is what actually dispatches a supertest request.
    const pending = save({ path: LOGIN, content: 'second', lastCommitId: readLastCommitId, branchSlug: 'Login fixes' }).then((r) => r);
    await waitForRequests(fake, '/repository/commits', 2);
    // A push lands on the work branch after our pre-check read but before our own commit is let through.
    fake.setFile(P, WORK_BRANCH, LOGIN, 'pushed from a laptop while we were mid-save');
    release();

    const res = await pending;
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('This file changed on the branch – reload it before saving');
  });

  it('rejects the default-branch guard when a project links a default branch shaped like a work branch', async () => {
    await ctx.prisma.project.update({ where: { id: projectId }, data: { defaultBranch: WORK_BRANCH } });
    const res = await save({ path: LOGIN, content: 'x', lastCommitId: mainCommit(LOGIN), branchSlug: 'Login fixes' }).expect(400);
    expect(res.body.message).toBe('The tool never commits to the default branch');
  });

  it('rejects an invalid ref', async () => {
    const res = await ctx.http().get(`${base()}/tree`).query({ ref: 'bad branch' }).set(actors.testerAuth).expect(400);
    expect(res.body.message).toBe('Validation failed');
    expect(res.body.details[0]).toContain('ref is not a valid branch name');
  });

  it('refuses automation routes for a user with no GitLab connection', async () => {
    const res = await ctx.http().get(`${base()}/tree`).set(actors.adminAuth).expect(403);
    expect(res.body.details).toMatchObject({ code: 'GITLAB_NOT_CONNECTED' });
  });

  it('requires a linked repository', async () => {
    await ctx.prisma.project.update({ where: { id: projectId }, data: { gitlabProjectId: null } });
    const res = await ctx.http().get(`${base()}/tree`).set(actors.testerAuth).expect(409);
    expect(res.body.message).toBe('Project is not linked to a GitLab repository');
  });
});
