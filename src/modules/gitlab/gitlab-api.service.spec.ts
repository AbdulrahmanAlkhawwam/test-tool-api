import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { FakeGitlab, FakeUser } from '../../../test/utils/fake-gitlab';
import { GitlabApiService } from './gitlab-api.service';
import { GitlabHttpError } from './gitlab-http-error';

const REDIRECT_URI = 'http://localhost:3000/api/gitlab/oauth/callback';

describe('GitlabApiService (against the fake GitLab)', () => {
  let fake: FakeGitlab;
  let api: GitlabApiService;
  let user: FakeUser;
  let token: string;

  beforeAll(async () => {
    fake = await FakeGitlab.start();
    const config = { getOrThrow: () => ({ url: fake.url, clientId: 'test-client', clientSecret: 'test-secret', redirectUri: REDIRECT_URI }) };
    api = new GitlabApiService(config as unknown as ConfigService);
  });
  beforeEach(() => {
    fake.reset();
    user = fake.addUser({ username: 'tess', avatar_url: 'https://git.test/tess.png' });
    token = fake.issueTokens(user).accessToken;
  });
  afterAll(async () => {
    await fake.close();
  });

  it('reads the current user with the bearer token', async () => {
    expect(await api.getCurrentUser(token)).toEqual({ id: user.id, username: 'tess', name: 'tess', avatarUrl: 'https://git.test/tess.png' });
    expect(fake.requests.at(-1)).toMatchObject({ method: 'GET', path: '/api/v4/user', token });
  });

  it('turns GitLab 401s into GitlabHttpError', async () => {
    await expect(api.getCurrentUser('nope')).rejects.toBeInstanceOf(GitlabHttpError);
    await expect(api.getCurrentUser('nope')).rejects.toMatchObject({ status: 401, message: '401 Unauthorized' });
  });

  it('follows tree pagination', async () => {
    const files = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`e2e/t${String(i).padStart(3, '0')}.spec.ts`, 'x']));
    fake.addProject({ id: 7, path: 'group/app', members: [user], files: { ...files, 'README.md': '# app' } });
    const tree = await api.listTree(token, 7, 'main', 'e2e');
    expect(tree).toHaveLength(150);
    expect(tree[0]).toEqual({ path: 'e2e/t000.spec.ts', name: 't000.spec.ts', type: 'blob' });
    expect(fake.requestsTo('/repository/tree')).toHaveLength(2);
  });

  it('reads a file with its last commit id, and returns null when it is missing', async () => {
    fake.addProject({ id: 7, path: 'group/app', members: [user], files: { 'e2e/a.spec.ts': "test('a @TC-AUTH-001')" } });
    expect(await api.getFile(token, 7, 'main', 'e2e/a.spec.ts')).toEqual({
      path: 'e2e/a.spec.ts',
      content: "test('a @TC-AUTH-001')",
      size: 22,
      lastCommitId: fake.file(7, 'main', 'e2e/a.spec.ts')!.lastCommitId,
      isValidUtf8: true,
    });
    expect(await api.getFile(token, 7, 'main', 'e2e/missing.ts')).toBeNull();
  });

  it('flags content that is not valid UTF-8, without corrupting the bytes actually read', async () => {
    fake.addProject({ id: 7, path: 'group/app', members: [user], files: { 'e2e/a.spec.ts': 'text' } });
    fake.setBinaryFile(7, 'main', 'e2e/bin.spec.ts', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]));
    const file = await api.getFile(token, 7, 'main', 'e2e/bin.spec.ts');
    expect(file!.isValidUtf8).toBe(false);
    expect(file!.size).toBe(8);
  });

  it('gets a file\'s size and last commit id via HEAD without a body, and returns null when missing', async () => {
    fake.addProject({ id: 7, path: 'group/app', members: [user], files: { 'e2e/a.spec.ts': "test('a @TC-AUTH-001')" } });
    const head = await api.headFile(token, 7, 'main', 'e2e/a.spec.ts');
    expect(head).toEqual({
      size: 22,
      lastCommitId: fake.file(7, 'main', 'e2e/a.spec.ts')!.lastCommitId,
      blobId: expect.any(String),
    });
    expect(fake.requestsTo('/repository/files', 'HEAD')).toHaveLength(1);
    expect(await api.headFile(token, 7, 'main', 'e2e/missing.ts')).toBeNull();
  });

  it('commits to a new branch from start_branch and opens a merge request', async () => {
    fake.addProject({ id: 7, path: 'group/app', members: [user], files: { 'e2e/a.spec.ts': 'old' } });
    const commit = await api.createCommit(token, 7, {
      branch: 'tests/tess-fix',
      startBranch: 'main',
      message: 'Update e2e/a.spec.ts',
      actions: [{ action: 'update', filePath: 'e2e/a.spec.ts', content: 'new', lastCommitId: fake.file(7, 'main', 'e2e/a.spec.ts')!.lastCommitId }],
    });
    expect(fake.file(7, 'tests/tess-fix', 'e2e/a.spec.ts')).toEqual({ content: 'new', lastCommitId: commit.id });
    expect(fake.file(7, 'main', 'e2e/a.spec.ts')!.content).toBe('old');
    expect(await api.getBranch(token, 7, 'tests/tess-fix')).toEqual({ name: 'tests/tess-fix', commitId: commit.id });
    expect(await api.getBranch(token, 7, 'tests/none')).toBeNull();

    const mr = await api.createMergeRequest(token, 7, { sourceBranch: 'tests/tess-fix', targetBranch: 'main', title: 'Tests: fix', description: 'd' });
    expect(mr).toMatchObject({ iid: 1, state: 'opened', sourceBranch: 'tests/tess-fix', webUrl: `${fake.url}/group/app/-/merge_requests/1` });
    expect(await api.listMergeRequests(token, 7, { sourceBranch: 'tests/tess-fix', state: 'opened' })).toHaveLength(1);
  });

  it('flattens GitLab validation errors from pipeline creation', async () => {
    fake.addProject({ id: 7, path: 'group/app', members: [user], ciEnabled: false });
    await expect(api.createPipeline(token, 7, 'main', { EJAD_RUN_ID: 'r1' })).rejects.toMatchObject({
      status: 400,
      message: 'Pipeline will not run for the selected trigger. The rules configuration prevented any jobs from being added to the pipeline.',
    });
  });

  it('exchanges an authorization code with PKCE and rotates refresh tokens', async () => {
    const verifier = 'v'.repeat(64);
    const code = fake.issueAuthCode(user, createHash('sha256').update(verifier).digest('base64url'), REDIRECT_URI);
    await expect(api.exchangeCode(code, 'wrong-verifier')).rejects.toMatchObject({ status: 400 });

    const tokens = await api.exchangeCode(code, verifier);
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now() + 7_000_000);
    expect((await api.getCurrentUser(tokens.accessToken)).username).toBe('tess');

    const refreshed = await api.refreshTokens(tokens.refreshToken);
    expect(refreshed.accessToken).not.toBe(tokens.accessToken);
    await expect(api.refreshTokens(tokens.refreshToken)).rejects.toMatchObject({
      status: 400,
      message: 'The provided authorization grant is invalid',
    });
  });
});
