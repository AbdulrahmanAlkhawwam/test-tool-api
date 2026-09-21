import { GitlabConnectionState, Project } from '@prisma/client';
import { TokenCipher } from '../../src/common/crypto/token-cipher';
import { FakeGitlab, FakeProject, FakeUser } from './fake-gitlab';
import { createTestApp, TestContext } from './test-app';

export const GITLAB_PROJECT_ID = 101;

export const LOGIN_SPEC = [
  "import { expect, test } from '@playwright/test';",
  '',
  "test('logs in with valid credentials @TC-AUTH-001', async ({ page }) => {",
  "  await page.goto('/login');",
  '});',
  '',
  "test('shows an error for a wrong password @TC-AUTH-002 @TC-AUTH-999', async ({ page }) => {",
  "  await page.goto('/login');",
  '});',
  '',
].join('\n');

export const CART_SPEC = [
  "import { test } from '@playwright/test';",
  '',
  "test('adds an item to the cart', async ({ page }) => {",
  "  await page.goto('/cart');",
  '});',
  '',
].join('\n');

export const SAMPLE_FILES: Record<string, string> = {
  'e2e/auth/login.spec.ts': LOGIN_SPEC,
  'e2e/cart/cart.spec.ts': CART_SPEC,
  'e2e/fixtures/users.ts': 'export const users = [];\n',
  'src/app.ts': 'console.log("app");\n',
  'playwright.config.ts': 'export default {};\n',
};

/** Starts a fake GitLab and an app whose GITLAB_URL points at it (see createTestApp for how env is applied). */
export async function createGitlabTestApp(env: Record<string, string | undefined> = {}): Promise<{ ctx: TestContext; fake: FakeGitlab }> {
  const fake = await FakeGitlab.start();
  const ctx = await createTestApp({ GITLAB_URL: fake.url, ...env });
  return { ctx, fake };
}

/** Stores a GitLab connection for a tool user, with tokens the fake GitLab accepts. */
export async function seedGitlabConnection(
  ctx: TestContext,
  fake: FakeGitlab,
  userId: string,
  opts: { username?: string; gitlabUser?: FakeUser; expired?: boolean; state?: GitlabConnectionState } = {},
): Promise<{ gitlabUser: FakeUser; accessToken: string; refreshToken: string }> {
  const gitlabUser = opts.gitlabUser ?? fake.addUser({ username: opts.username ?? 'tess' });
  const tokens = fake.issueTokens(gitlabUser, { expired: opts.expired });
  const cipher = ctx.app.get(TokenCipher);
  await ctx.prisma.gitlabConnection.create({
    data: {
      userId,
      gitlabUserId: gitlabUser.id,
      username: gitlabUser.username,
      avatarUrl: gitlabUser.avatar_url,
      accessTokenEnc: cipher.encrypt(tokens.accessToken),
      refreshTokenEnc: cipher.encrypt(tokens.refreshToken),
      expiresAt: new Date(Date.now() + (opts.expired ? -60_000 : 7_200_000)),
      state: opts.state ?? GitlabConnectionState.ACTIVE,
    },
  });
  return { gitlabUser, ...tokens };
}

/**
 * Polls until at least `count` requests matching `pathPart` have reached the fake (its request
 * log is written by middleware that runs before any per-route gate, so this detects a request
 * that is currently held mid-flight by `fake.holdTokenResponses()`). Used to line up a concurrent
 * disconnect/refresh race with a request we know is paused waiting on GitLab.
 */
export async function waitForRequests(fake: FakeGitlab, pathPart: string, count = 1, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (fake.requestsTo(pathPart).length < count) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${count} request(s) to ${pathPart}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A tool project linked to GitLab project 101 (mobile/ninja-store, default branch main, tests in e2e/). */
export async function seedLinkedProject(
  ctx: TestContext,
  fake: FakeGitlab,
  createdById: string,
  members: FakeUser[],
  opts: { ciEnabled?: boolean } = {},
): Promise<{ project: Project; glProject: FakeProject }> {
  const glProject = fake.addProject({
    id: GITLAB_PROJECT_ID,
    path: 'mobile/ninja-store',
    defaultBranch: 'main',
    members,
    ciEnabled: opts.ciEnabled,
    files: SAMPLE_FILES,
  });
  const project = await ctx.prisma.project.create({
    data: {
      key: 'NINJA',
      name: 'Ninja Store',
      createdById,
      gitlabProjectId: GITLAB_PROJECT_ID,
      gitlabPath: 'mobile/ninja-store',
      gitlabWebUrl: glProject.web_url,
      defaultBranch: 'main',
      testsPath: 'e2e',
      playwrightConfigPath: 'playwright.config.ts',
    },
  });
  return { project, glProject };
}
