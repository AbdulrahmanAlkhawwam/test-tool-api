# Ejad Test Case Tool — API Phase 2 (GitLab Test Automation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitLab test automation to `ejad-testcases-api`. This covers per-user GitLab OAuth, a repository link per project, reading the tests folder (tree, files, coverage by `@TC-…` tags), saving edits to a work branch with a merge request, starting GitLab CI pipelines as Automated runs, and importing the pipeline test report back into run results.

**Architecture:** There are three new feature modules. `gitlab` holds OAuth, encrypted token storage, a small `fetch`-based GitLab REST client and the "GitLab enabled" guard. `automation` holds the repository link, tree/file/save and coverage. `automated-runs` holds the pipeline trigger, the pipeline poller, the result importer and create-case-from-unlinked. Every GitLab call uses the acting user's own OAuth token. The poller uses the triggering user's token. The server never runs repository code. Pure logic (encryption, path rules, branch names, tag extraction, coverage, MR description, pipeline variables, report mapping, CI snippet) lives in small functions with unit tests. The e2e tests run the whole app against a **fake GitLab server**, which is an in-memory Express app on a random port.

**Tech Stack:** Node 22 (built-in `fetch`, `AbortSignal.timeout`), NestJS 10, Prisma 7 + @prisma/adapter-pg, PostgreSQL 16, `@nestjs/schedule` 4 (new), Node `crypto` (AES-256-GCM, SHA-256, PKCE), Jest + ts-jest + supertest, Express 4 (already installed through `@nestjs/platform-express`) for the fake GitLab.

**Spec:** `docs/superpowers/specs/2026-09-18-gitlab-automation-design.md` (implement §3, §4, §5, §7, §8, §9, §11, §12 API parts; §13 steps 1–3 and the README part of step 6). Context: `docs/superpowers/specs/2026-09-18-ejad-test-case-tool-design.md`.

## Global Constraints

- Repo root: `C:\Users\User\StudioProjects\ejad-testcases-api` (Git Bash paths: `/c/Users/User/StudioProjects/ejad-testcases-api`). Base: the Phase 1 code **after** the final-review fix wave (`fix/api-final-review`) is merged. Create `feat/api-phase2-gitlab` from it. The plan relies on the fix-wave code: `IsOptionalNonNull`, the `FOR SHARE`/`FOR UPDATE` run locks, the `resetDb` `_test` guard, `trustProxy` config and P2003 → 409.
- All routes use the global prefix `/api`, and Swagger is at `/api/docs`.
- Error body shape everywhere: `{ statusCode, error, message, details? }`. GitLab errors that pass through to the client have `details: { source: 'gitlab' }`. Missing or broken connections return 403 with `details: { code: 'GITLAB_NOT_CONNECTED' | 'GITLAB_NEEDS_RECONNECT' }`.
- Database: native PostgreSQL on `localhost:5442`. The dev DB is `ejad_testcases` (`.env`) and the test DB is `ejad_testcases_test` (`.env.test`). **Never run `npm run db:up`** (Docker is not used here). `npm run test:e2e` applies migrations to the test DB by itself.
- Every commit message ends with a blank line and then `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Test output must be clean: no failures, no warnings (no DeprecationWarning, no "open handles", no "did not exit"), and no stray console output. Nothing inside a Prisma transaction may run in parallel (`Promise.all`), because that causes the pg concurrent-query deprecation.
- **GitLab features are off when `GITLAB_URL` is unset.** `GET /api/gitlab/status` returns `{ enabled: false, connection: null }`, and every other GitLab/automation endpoint returns **404** (`GitlabEnabledGuard`). Phase 1 behaviour and tests must stay unchanged.
- **The tool never executes repository code.** It only reads files through the GitLab API, and tests run on GitLab CI runners.
- **Edits are limited to `testsPath`.** Every read/write path is normalized and must be inside the project's `testsPath` (no `..`/`.` segments). Writable files end in `.ts` or `.js`. The tool **never commits to the default branch**: every save goes to `tests/<gitlab-username>-<slug>`.
- GitLab access/refresh tokens and PKCE verifiers are stored **AES-256-GCM encrypted** (random 12-byte IV and auth tag) with the key from `TOKEN_ENCRYPTION_KEY`. OAuth `state` values are stored only as SHA-256 hashes, are single-use, bound to the user and expire after 10 minutes.
- Run a **single** API container: the pipeline poller and the per-user token-refresh lock live in memory.
- Test count baseline: the fix-wave report (`.superpowers/sdd/2026-09-18-api-phase1/final-fix-report.md`) was not available, so the baseline was counted on `fix/api-final-review` at `0f6e11b`: **57 unit / 74 e2e**. If the finished fix wave ends with different numbers, shift every cumulative count below by the same difference.

## File Structure

```
ejad-testcases-api/
  .env.example, .env.test, README.md                      (modified)
  package.json                                             (+ @nestjs/schedule)
  prisma/schema.prisma                                     (modified) + prisma/migrations/<ts>_gitlab_automation/
  src/
    app.module.ts                                          (+ ScheduleModule, GitlabModule, AutomationModule, AutomatedRunsModule)
    app.setup.ts                                           (JSON body limit 2 MB for file saves)
    config/configuration.ts (+ .spec.ts)                   GitlabConfig, parseGitlabConfig
    common/crypto/token-cipher.ts (+ .spec.ts)             TokenCipher (AES-256-GCM), sha256Hex
    modules/
      gitlab/
        gitlab.types.ts                                    GitLab domain types (camelCase)
        gitlab-http-error.ts                               GitlabHttpError, gitlabErrorMessage, toHttpException
        gitlab-api.service.ts (+ .spec.ts)                 fetch-based REST + OAuth client
        gitlab-connection.service.ts                       OAuth/PKCE, token storage, refresh, withToken
        gitlab-enabled.guard.ts                            404 when GITLAB_URL is unset
        gitlab.controller.ts, gitlab.module.ts
      automation/
        paths.ts (+ .spec.ts)                              normalizeRepoPath, resolveInTestsPath, resolveEditablePath,
                                                           workBranchName, workBranchPrefix, BRANCH_NAME_RE
        case-tags.ts (+ .spec.ts)                          extractCaseTags
        mr-description.ts (+ .spec.ts)                     buildMrDescription
        coverage.ts (+ .spec.ts), coverage-cache.ts        computeCoverage, CoverageCache
        coverage.service.ts, coverage.controller.ts        GET automation/coverage
        ci-snippet.ts (+ .spec.ts), ci-snippet.controller.ts  ciSnippet, GET automation/ci-snippet
        dto/link-repository.dto.ts, dto/automation-query.dto.ts, dto/save-file.dto.ts
        repository.service.ts, repository.controller.ts
        automation.service.ts, automation.controller.ts, automation.module.ts
      automated-runs/
        run-scope.ts (+ .spec.ts)                          pipelineVariables, automatedRunName
        report-mapper.ts (+ .spec.ts)                      mapTestReport, mapTestStatus
        dto/create-automated-run.dto.ts, dto/create-case-from-result.dto.ts
        automated-runs.service.ts, result-importer.service.ts, pipeline-poller.service.ts
        unlinked-results.service.ts                        suggestCaseName, create-case
        automated-runs.controller.ts, automated-runs.module.ts
      runs/runs.module.ts, runs/runs.service.ts            (export RunsService; include triggeredBy)
  test/
    utils/test-app.ts                                      createTestApp(env overrides), resetDb (+ GitLab tables)
    utils/fake-gitlab.ts                                   FakeGitlab (Express, in-memory)
    utils/gitlab.ts                                        createGitlabTestApp, seedGitlabConnection, seedLinkedProject, SAMPLE_FILES
    gitlab-connection.e2e-spec.ts, gitlab-disabled.e2e-spec.ts, repository.e2e-spec.ts,
    automation-files.e2e-spec.ts, automation-coverage.e2e-spec.ts, automated-runs.e2e-spec.ts,
    pipeline-import.e2e-spec.ts, automation-extras.e2e-spec.ts
```

**How the e2e tests reach the fake GitLab.** `.env.test` leaves `GITLAB_URL` unset, so all Phase 1 e2e files run with GitLab disabled. The configuration factory in `ConfigModule.forRoot({ load: [configuration] })` runs when the Nest testing module is **compiled**, not when `app.module.ts` is imported. `createTestApp(env)` therefore applies the given environment overrides (a value of `undefined` deletes the variable), compiles and initializes the app, and then puts the previous values back. `createGitlabTestApp()` first starts `FakeGitlab` on `127.0.0.1:<random port>` and then calls `createTestApp({ GITLAB_URL: fake.url })`, so each GitLab test file gets its own fake server and nothing touches the network. The OAuth client id, secret, redirect URI, encryption key, `WEB_URL` and `GITLAB_POLL_INTERVAL_MS=0` (the interval is off in tests; the tests call `PipelinePollerService.pollOnce()` directly) come from `.env.test`.

**Test counts (cumulative, unit / e2e):** baseline 57 / 74 → T1 64 / 74 → T2 71 / 74 → T3 71 / 87 → T4 79 / 93 → T5 84 / 103 → T6 87 / 106 → T7 89 / 112 → T8 95 / 118 → T9 97 / 122.

---

### Task 1: Schema, migration, GitLab config and token encryption

**Files:**
- Modify: `prisma/schema.prisma`, `src/config/configuration.ts`, `src/config/configuration.spec.ts`, `test/utils/test-app.ts` (`resetDb` truncates the new tables), `.env.test`, `.env.example`
- Create: `prisma/migrations/<timestamp>_gitlab_automation/migration.sql` (generated), `src/common/crypto/token-cipher.ts`
- Test: `src/common/crypto/token-cipher.spec.ts`, `src/config/configuration.spec.ts`

**Interfaces:**
- Produces:
  - Prisma: `enum GitlabConnectionState { ACTIVE NEEDS_RECONNECT }`. `GitlabConnection { id, userId @unique, gitlabUserId Int, username, avatarUrl?, accessTokenEnc, refreshTokenEnc, expiresAt, state, createdAt, updatedAt }`. `GitlabOAuthState { id, userId, stateHash @unique, codeVerifierEnc, expiresAt, usedAt?, createdAt }`. `Project + gitlabProjectId Int?, gitlabPath?, gitlabWebUrl?, defaultBranch?, testsPath?, playwrightConfigPath?`. `TestRun + branch?, pipelineId Int?, pipelineWebUrl?, pipelineStatus?, triggeredById?, triggeredBy User? ("RunTriggeredBy"), note?` and `@@index([type, status])`. `TestResult + file?, artifactsUrl?`.
  - `interface GitlabConfig { enabled: boolean; url: string; clientId: string; clientSecret: string; redirectUri: string; tokenEncryptionKey: string; webUrl: string; pollIntervalMs: number; runTimeoutMs: number }`. `parseGitlabConfig(env: NodeJS.ProcessEnv): GitlabConfig`. Config key `gitlab` (read with `config.getOrThrow<GitlabConfig>('gitlab')`).
  - `class TokenCipher { constructor(keyBase64: string); encrypt(plain: string): string; decrypt(payload: string): string }` (format `v1:<base64(iv|tag|ciphertext)>`). `sha256Hex(value: string): string`.

- [ ] **Step 1: Write the failing unit tests**

`src/common/crypto/token-cipher.spec.ts`:
```ts
import { TokenCipher, sha256Hex } from './token-cipher';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('TokenCipher', () => {
  it('round-trips a token', () => {
    const cipher = new TokenCipher(KEY);
    const encrypted = cipher.encrypt('glpat-secret-token');
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(encrypted).not.toContain('glpat-secret-token');
    expect(cipher.decrypt(encrypted)).toBe('glpat-secret-token');
  });

  it('uses a random IV for every encryption', () => {
    const cipher = new TokenCipher(KEY);
    const a = cipher.encrypt('same');
    const b = cipher.encrypt('same');
    expect(a).not.toBe(b);
    expect(cipher.decrypt(a)).toBe('same');
    expect(cipher.decrypt(b)).toBe('same');
  });

  it('rejects tampered ciphertext and a different key', () => {
    const cipher = new TokenCipher(KEY);
    const raw = Buffer.from(cipher.encrypt('token').slice(3), 'base64');
    raw[raw.length - 1] ^= 0xff;
    expect(() => cipher.decrypt(`v1:${raw.toString('base64')}`)).toThrow();
    const other = new TokenCipher(Buffer.alloc(32, 9).toString('base64'));
    expect(() => other.decrypt(cipher.encrypt('token'))).toThrow();
    expect(() => cipher.decrypt('plain-text')).toThrow('Unsupported encrypted token format');
  });

  it('requires a 32-byte key and hashes with SHA-256', () => {
    expect(() => new TokenCipher(Buffer.alloc(16).toString('base64'))).toThrow('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
```

Replace `src/config/configuration.spec.ts` with this (the existing `parseTrustProxy` tests are kept word for word, and one `describe` is added):
```ts
import { parseGitlabConfig, parseTrustProxy } from './configuration';

describe('parseTrustProxy', () => {
  it('leaves trust proxy unset when TRUST_PROXY is missing or blank', () => {
    expect(parseTrustProxy(undefined)).toBeUndefined();
    expect(parseTrustProxy('  ')).toBeUndefined();
  });

  it('parses booleans and hop counts', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy(' 2 ')).toBe(2);
  });

  it('passes other Express values through', () => {
    expect(parseTrustProxy('loopback')).toBe('loopback');
  });
});

describe('parseGitlabConfig', () => {
  const KEY = Buffer.alloc(32, 1).toString('base64');

  it('is disabled when GITLAB_URL is unset, with defaults', () => {
    expect(parseGitlabConfig({})).toEqual({
      enabled: false,
      url: '',
      clientId: '',
      clientSecret: '',
      redirectUri: '',
      tokenEncryptionKey: '',
      webUrl: 'http://localhost:3001',
      pollIntervalMs: 20_000,
      runTimeoutMs: 7_200_000,
    });
  });

  it('reads an enabled configuration and trims trailing slashes', () => {
    const config = parseGitlabConfig({
      GITLAB_URL: 'https://git.ejad.net/',
      GITLAB_OAUTH_CLIENT_ID: 'id',
      GITLAB_OAUTH_CLIENT_SECRET: 'secret',
      GITLAB_OAUTH_REDIRECT_URI: 'https://api.test/api/gitlab/oauth/callback',
      TOKEN_ENCRYPTION_KEY: KEY,
      WEB_URL: 'https://tests.ejad.net/',
      GITLAB_POLL_INTERVAL_MS: '5000',
      GITLAB_RUN_TIMEOUT_MINUTES: '30',
    });
    expect(config).toMatchObject({
      enabled: true,
      url: 'https://git.ejad.net',
      webUrl: 'https://tests.ejad.net',
      pollIntervalMs: 5000,
      runTimeoutMs: 1_800_000,
    });
  });

  it('fails fast on missing OAuth settings or a bad encryption key', () => {
    expect(() => parseGitlabConfig({ GITLAB_URL: 'https://git.ejad.net' })).toThrow(
      'GITLAB_URL is set, so these variables are required too: GITLAB_OAUTH_CLIENT_ID, GITLAB_OAUTH_CLIENT_SECRET, GITLAB_OAUTH_REDIRECT_URI, TOKEN_ENCRYPTION_KEY',
    );
    expect(() =>
      parseGitlabConfig({
        GITLAB_URL: 'https://git.ejad.net',
        GITLAB_OAUTH_CLIENT_ID: 'id',
        GITLAB_OAUTH_CLIENT_SECRET: 'secret',
        GITLAB_OAUTH_REDIRECT_URI: 'https://api.test/cb',
        TOKEN_ENCRYPTION_KEY: 'c2hvcnQ=',
      }),
    ).toThrow('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest token-cipher configuration`
Expected: FAIL. token-cipher reports "Cannot find module './token-cipher'", and configuration fails to compile with "Module './configuration' has no exported member 'parseGitlabConfig'".

- [ ] **Step 3: Implement the cipher and the config**

`src/common/crypto/token-cipher.ts`:
```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM encryption for secrets stored at rest (GitLab tokens, PKCE verifiers). */
export class TokenCipher {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
    this.key = key;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_BYTES });
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
  }

  decrypt(payload: string): string {
    const [version, body] = payload.split(':');
    if (version !== VERSION || !body) throw new Error('Unsupported encrypted token format');
    const raw = Buffer.from(body, 'base64');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const data = raw.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
```

Replace `src/config/configuration.ts` with:
```ts
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Environment variable ${name} is required`);
  return value;
}

/**
 * Express "trust proxy" setting from TRUST_PROXY: unset → undefined (not applied, Express
 * default false); "true"/"false" → boolean; a number → hop count (e.g. 1 behind Traefik);
 * anything else (e.g. "loopback" or a subnet list) is passed through as-is.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return value;
}

export interface GitlabConfig {
  /** false when GITLAB_URL is unset: every GitLab endpoint then answers 404. */
  enabled: boolean;
  url: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenEncryptionKey: string;
  /** Where the OAuth callback sends the browser back to. */
  webUrl: string;
  /** Pipeline poller interval; 0 disables the interval (tests call pollOnce directly). */
  pollIntervalMs: number;
  /** Automated runs still unfinished after this long are closed. */
  runTimeoutMs: number;
}

const stripSlash = (value: string) => value.trim().replace(/\/+$/, '');

export function parseGitlabConfig(env: NodeJS.ProcessEnv): GitlabConfig {
  const url = stripSlash(env.GITLAB_URL ?? '');
  const config: GitlabConfig = {
    enabled: url !== '',
    url,
    clientId: env.GITLAB_OAUTH_CLIENT_ID ?? '',
    clientSecret: env.GITLAB_OAUTH_CLIENT_SECRET ?? '',
    redirectUri: env.GITLAB_OAUTH_REDIRECT_URI ?? '',
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY ?? '',
    webUrl: stripSlash(env.WEB_URL ?? 'http://localhost:3001'),
    pollIntervalMs: parseInt(env.GITLAB_POLL_INTERVAL_MS ?? '20000', 10),
    runTimeoutMs: parseInt(env.GITLAB_RUN_TIMEOUT_MINUTES ?? '120', 10) * 60_000,
  };
  if (config.enabled) {
    const missing = (
      [
        ['GITLAB_OAUTH_CLIENT_ID', config.clientId],
        ['GITLAB_OAUTH_CLIENT_SECRET', config.clientSecret],
        ['GITLAB_OAUTH_REDIRECT_URI', config.redirectUri],
        ['TOKEN_ENCRYPTION_KEY', config.tokenEncryptionKey],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length) throw new Error(`GITLAB_URL is set, so these variables are required too: ${missing.join(', ')}`);
    if (Buffer.from(config.tokenEncryptionKey, 'base64').length !== 32) {
      throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
    }
  }
  return config;
}

export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  corsOrigins: (process.env.CORS_ORIGIN ?? 'http://localhost:3001').split(',').map((o) => o.trim()),
  jwt: {
    accessSecret: required('JWT_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtlDays: parseInt(process.env.JWT_REFRESH_TTL_DAYS ?? '7', 10),
  },
  cookie: {
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: (process.env.COOKIE_SAMESITE ?? 'lax') as 'lax' | 'strict' | 'none',
  },
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  loginRateLimit: parseInt(process.env.LOGIN_RATE_LIMIT ?? '10', 10),
  gitlab: parseGitlabConfig(process.env),
});
```

Run: `npx jest token-cipher configuration`
Expected: 4 + 6 = 10 tests pass.

- [ ] **Step 4: Extend the Prisma schema**

In `prisma/schema.prisma`, add this enum after `enum ResultStatus { … }`:
```prisma
enum GitlabConnectionState {
  ACTIVE
  NEEDS_RECONNECT
}
```

Replace the `User`, `Project`, `TestRun` and `TestResult` models with the versions below. Only the lines marked `// Phase 2` are new. Then add the two new models at the end of the file:
```prisma
model User {
  id                String             @id @default(uuid())
  name              String
  email             String             @unique
  passwordHash      String
  role              Role               @default(TESTER)
  active            Boolean            @default(true)
  createdAt         DateTime           @default(now())
  updatedAt         DateTime           @updatedAt
  projectsCreated   Project[]          @relation("ProjectCreatedBy")
  casesCreated      TestCase[]         @relation("CaseCreatedBy")
  casesUpdated      TestCase[]         @relation("CaseUpdatedBy")
  runsCreated       TestRun[]          @relation("RunCreatedBy")
  runsTriggered     TestRun[]          @relation("RunTriggeredBy") // Phase 2
  resultsExecuted   TestResult[]       @relation("ResultExecutedBy")
  gitlabConnection  GitlabConnection? // Phase 2
  gitlabOAuthStates GitlabOAuthState[] // Phase 2
}

model Project {
  id                   String          @id @default(uuid())
  name                 String
  key                  String          @unique
  description          String?
  createdById          String
  createdBy            User            @relation("ProjectCreatedBy", fields: [createdById], references: [id])
  archivedAt           DateTime?
  createdAt            DateTime        @default(now())
  updatedAt            DateTime        @updatedAt
  gitlabProjectId      Int? // Phase 2
  gitlabPath           String? // Phase 2, e.g. mobile/ninja-store
  gitlabWebUrl         String? // Phase 2
  defaultBranch        String? // Phase 2
  testsPath            String? // Phase 2, e.g. e2e
  playwrightConfigPath String? // Phase 2
  modules              ProjectModule[]
  testCases            TestCase[]
  runs                 TestRun[]
}

model TestRun {
  id             String       @id @default(uuid())
  projectId      String
  project        Project      @relation(fields: [projectId], references: [id], onDelete: Cascade)
  name           String
  build          String?
  environment    String?
  type           RunType      @default(MANUAL)
  status         RunStatus    @default(IN_PROGRESS)
  createdById    String
  createdBy      User         @relation("RunCreatedBy", fields: [createdById], references: [id])
  startedAt      DateTime     @default(now())
  completedAt    DateTime?
  branch         String? // Phase 2
  pipelineId     Int? // Phase 2
  pipelineWebUrl String? // Phase 2
  pipelineStatus String? // Phase 2: created | pending | running | success | failed | canceled | …
  triggeredById  String? // Phase 2
  triggeredBy    User?        @relation("RunTriggeredBy", fields: [triggeredById], references: [id], onDelete: SetNull) // Phase 2
  note           String? // Phase 2
  results        TestResult[]

  @@index([projectId, startedAt])
  @@index([type, status])
}

model TestResult {
  id           String       @id @default(uuid())
  runId        String
  run          TestRun      @relation(fields: [runId], references: [id], onDelete: Cascade)
  testCaseId   String?
  testCase     TestCase?    @relation(fields: [testCaseId], references: [id], onDelete: Restrict)
  title        String?
  status       ResultStatus @default(NOT_EXECUTED)
  actualResult String?
  notes        String?
  durationMs   Int?
  errorMessage String?
  errorStack   String?
  file         String? // Phase 2: test file of an automated result
  artifactsUrl String? // Phase 2: GitLab job artifacts browser
  executedById String?
  executedBy   User?        @relation("ResultExecutedBy", fields: [executedById], references: [id])
  executedAt   DateTime?
  updatedAt    DateTime     @updatedAt

  @@unique([runId, testCaseId])
  @@index([testCaseId])
}

model GitlabConnection {
  id              String                @id @default(uuid())
  userId          String                @unique
  user            User                  @relation(fields: [userId], references: [id], onDelete: Cascade)
  gitlabUserId    Int
  username        String
  avatarUrl       String?
  accessTokenEnc  String
  refreshTokenEnc String
  expiresAt       DateTime
  state           GitlabConnectionState @default(ACTIVE)
  createdAt       DateTime              @default(now())
  updatedAt       DateTime              @updatedAt
}

model GitlabOAuthState {
  id              String    @id @default(uuid())
  userId          String
  user            User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  stateHash       String    @unique
  codeVerifierEnc String
  expiresAt       DateTime
  usedAt          DateTime?
  createdAt       DateTime  @default(now())

  @@index([userId])
}
```

- [ ] **Step 5: Create the migration and regenerate the client**

```bash
cd /c/Users/User/StudioProjects/ejad-testcases-api
npx prisma migrate dev --name gitlab_automation
npx prisma generate
```
Expected: `prisma/migrations/<timestamp>_gitlab_automation/migration.sql` is created. It only has `CREATE TYPE "GitlabConnectionState"`, `ALTER TABLE … ADD COLUMN` statements, the two `CREATE TABLE`s, their indexes and foreign keys: no `DROP`. The output says "Your database is now in sync with your schema" and "Generated Prisma Client". If Prisma asks to reset the dev database, stop: the dev DB has drifted, and a reset needs the user's permission first.

- [ ] **Step 6: Env files and the reset helper**

Append to `.env.test`:
```
# GitLab (Phase 2). GITLAB_URL stays unset here, so GitLab is disabled for Phase 1 tests;
# GitLab e2e files point it at their own fake GitLab server (test/utils/gitlab.ts).
GITLAB_OAUTH_CLIENT_ID=test-client
GITLAB_OAUTH_CLIENT_SECRET=test-secret
GITLAB_OAUTH_REDIRECT_URI=http://localhost:3000/api/gitlab/oauth/callback
TOKEN_ENCRYPTION_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=
WEB_URL=http://localhost:3001
GITLAB_POLL_INTERVAL_MS=0
```

Append to `.env.example`:
```
# GitLab test automation (Phase 2) — leave GITLAB_URL empty to disable all GitLab features
# GITLAB_URL=https://git.ejad.net
# GITLAB_OAUTH_CLIENT_ID=
# GITLAB_OAUTH_CLIENT_SECRET=
# GITLAB_OAUTH_REDIRECT_URI=http://localhost:3000/api/gitlab/oauth/callback
# 32 random bytes, base64: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# TOKEN_ENCRYPTION_KEY=
WEB_URL=http://localhost:3001
# GITLAB_POLL_INTERVAL_MS=20000
# GITLAB_RUN_TIMEOUT_MINUTES=120
```

In `test/utils/test-app.ts`, replace the `TRUNCATE` statement in `resetDb` with:
```ts
  await prisma.$executeRawUnsafe(
    'TRUNCATE "GitlabOAuthState", "GitlabConnection", "TestResult", "TestRun", "TestCase", "ProjectModule", "Project", "User" RESTART IDENTITY CASCADE',
  );
```

- [ ] **Step 7: Run everything to verify it passes**

Run: `npm run typecheck && npm test && npm run test:e2e`
Expected: tsc prints nothing, and the unit tests report `Tests: 64 passed, 64 total`. The e2e run first applies `gitlab_automation` to `ejad_testcases_test` and then reports `Tests: 74 passed, 74 total` (Phase 1 unchanged). The output has no warnings.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: GitLab automation schema, config and token encryption

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Fake GitLab server and the GitLab REST client

**Files:**
- Create: `test/utils/fake-gitlab.ts`, `src/modules/gitlab/gitlab.types.ts`, `src/modules/gitlab/gitlab-http-error.ts`, `src/modules/gitlab/gitlab-api.service.ts`
- Modify: `test/utils/test-app.ts` (`createTestApp(env)` overrides)
- Test: `src/modules/gitlab/gitlab-api.service.spec.ts`

**Interfaces:**
- Consumes: `GitlabConfig` (Task 1).
- Produces:
  - `class FakeGitlab` (test/utils/fake-gitlab.ts). Members: `static start(): Promise<FakeGitlab>`, `close(): Promise<void>`, `reset(): void`, `url: string`, `clientId = 'test-client'`, `clientSecret = 'test-secret'`, `addUser({ username, name?, avatar_url? }): FakeUser`, `issueTokens(user, { expired? }?): { accessToken; refreshToken }`, `issueAuthCode(user, codeChallenge, redirectUri): string`, `addProject({ id, path, defaultBranch?, members?, ciEnabled?, files? }): FakeProject`, `addMember(projectId, user)`, `addBranch(projectId, name, from?)`, `branch(projectId, name)`, `file(projectId, branch, path): FakeFile | undefined`, `setFile(projectId, branch, path, content): string` (new commit id), `pipeline(id): FakePipeline`, `setPipelineStatus(id, status)`, `finishPipeline(id, status, report | null, finishedAt?)` (also adds job `500 + id` named `ejad-playwright`), `requestsTo(pathPart, method?): FakeRequest[]`. State: `tokens`, `refreshTokens`, `issued`, `revoked`, `projects`, `mergeRequests`, `pipelines`, `requests`. Types: `FakeUser { id; username; name; avatar_url }`, `FakeTestCase`, `FakeTestReport { total_count; test_suites: { name; test_cases }[] }`.
  - Fake endpoints: `POST /oauth/token` (authorization_code with PKCE S256, refresh_token with single-use rotation), `POST /oauth/revoke`, and under `/api/v4` (Bearer auth; unknown token → 401 `{ message: '401 Unauthorized' }`; expired token → 401 `invalid_token`): `GET /user`, `GET /projects?search&membership`, `GET /projects/:id`, `GET /projects/:id/repository/tree?ref&path&recursive&per_page&page` (header `x-next-page`), `GET /projects/:id/repository/files/:path?ref`, `GET /projects/:id/repository/branches?search`, `GET /projects/:id/repository/branches/:branch`, `POST /projects/:id/repository/commits`, `GET|POST /projects/:id/merge_requests`, `PUT /projects/:id/merge_requests/:iid`, `POST /projects/:id/pipeline`, `GET /projects/:id/pipelines/:pid`, `GET /projects/:id/pipelines/:pid/test_report`, `GET /projects/:id/pipelines/:pid/jobs`. A ref can be a branch name or a branch's head commit id. A project the caller is not a member of answers 404 `404 Project Not Found`.
  - `gitlab.types.ts`: `GitlabUser { id; username; name; avatarUrl: string | null }`, `GitlabProject { id; name; pathWithNamespace; webUrl; defaultBranch: string | null }`, `GitlabTreeEntry { path; name; type: 'blob' | 'tree' }`, `GitlabFile { path; content; size; lastCommitId }`, `GitlabBranch { name; commitId }`, `GitlabCommit { id; webUrl }`, `CommitAction { action: 'create' | 'update'; filePath; content; lastCommitId? }`, `GitlabMergeRequest { iid; title; description; state; sourceBranch; webUrl }`, `GitlabPipeline { id; status; ref; webUrl; finishedAt: string | null }`, `GitlabJob { id; name; status; webUrl }`, `GitlabTestCase { status; name; classname; file: string | null; executionTime: number; systemOutput: string | null; stackTrace: string | null }`, `GitlabTestSuite { name; cases: GitlabTestCase[] }`, `OAuthTokens { accessToken; refreshToken; expiresAt: Date }`, `FINAL_PIPELINE_STATUSES: ReadonlySet<string>` (`success`, `failed`, `canceled`, `skipped`).
  - `class GitlabHttpError extends Error { status: number }` (status 0 = network error/timeout). `gitlabErrorMessage(body: unknown, status: number): string`. `toHttpException(e: GitlabHttpError): HttpException` (0/5xx → 502; otherwise the same status with `details: { source: 'gitlab' }`).
  - `GitlabApiService`: `exchangeCode(code, codeVerifier): Promise<OAuthTokens>`, `refreshTokens(refreshToken): Promise<OAuthTokens>`, `revokeToken(token): Promise<void>`, `getCurrentUser(token)`, `searchProjects(token, search)`, `getProject(token, projectId)`, `listTree(token, projectId, ref, path)`, `getFile(token, projectId, ref, path): Promise<GitlabFile | null>`, `getBranch(token, projectId, name): Promise<GitlabBranch | null>`, `listBranches(token, projectId, search)`, `createCommit(token, projectId, { branch, startBranch?, message, actions })`, `listMergeRequests(token, projectId, { sourceBranch, state: 'opened' | 'all' })` (newest first), `createMergeRequest(token, projectId, { sourceBranch, targetBranch, title, description })`, `updateMergeRequest(token, projectId, iid, { description })`, `createPipeline(token, projectId, ref, variables: Record<string, string>)`, `getPipeline(token, projectId, pipelineId)`, `getTestReport(token, projectId, pipelineId): Promise<GitlabTestSuite[]>`, `listPipelineJobs(token, projectId, pipelineId)`. Non-2xx → `GitlabHttpError`.
  - `createTestApp(env?: Record<string, string | undefined>): Promise<TestContext>`.

- [ ] **Step 1: Write the fake GitLab server**

`test/utils/fake-gitlab.ts`:
```ts
import { createHash, randomBytes } from 'crypto';
import express, { Request, Response } from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';

export interface FakeUser {
  id: number;
  username: string;
  name: string;
  avatar_url: string | null;
}
export interface FakeFile {
  content: string;
  lastCommitId: string;
}
export interface FakeBranch {
  name: string;
  commitId: string;
  files: Map<string, FakeFile>;
}
export interface FakeProject {
  id: number;
  name: string;
  path_with_namespace: string;
  web_url: string;
  default_branch: string;
  ciEnabled: boolean;
  memberIds: Set<number>;
  branches: Map<string, FakeBranch>;
}
export interface FakeMergeRequest {
  iid: number;
  project_id: number;
  source_branch: string;
  target_branch: string;
  title: string;
  description: string;
  state: 'opened' | 'merged' | 'closed';
  web_url: string;
}
export interface FakeTestCase {
  status: 'success' | 'failed' | 'skipped' | 'error';
  name: string;
  classname: string;
  file?: string | null;
  execution_time: number;
  system_output?: string | null;
  stack_trace?: string | null;
}
export interface FakeTestReport {
  total_count: number;
  test_suites: { name: string; test_cases: FakeTestCase[] }[];
}
export interface FakeJob {
  id: number;
  name: string;
  status: string;
  web_url: string;
}
export interface FakePipeline {
  id: number;
  project_id: number;
  ref: string;
  status: string;
  web_url: string;
  finished_at: string | null;
  variables: Record<string, string>;
  userId: number;
  testReport: FakeTestReport | null;
  jobs: FakeJob[];
}
export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, unknown>;
  token: string | null;
  body: unknown;
}

const sha = () => randomBytes(20).toString('hex');
const EMPTY_REPORT: FakeTestReport = { total_count: 0, test_suites: [] };
const INVALID_GRANT = { error: 'invalid_grant', error_description: 'The provided authorization grant is invalid' };

/**
 * In-memory stand-in for the GitLab endpoints the API uses. Each e2e file starts one on a random
 * local port; tests seed users/projects/files/pipelines and inspect `requests`.
 */
export class FakeGitlab {
  readonly clientId = 'test-client';
  readonly clientSecret = 'test-secret';
  url = '';
  users = new Map<number, FakeUser>();
  tokens = new Map<string, { user: FakeUser; expired: boolean }>();
  refreshTokens = new Map<string, FakeUser>();
  authCodes = new Map<string, { user: FakeUser; codeChallenge: string; redirectUri: string }>();
  issued: { accessToken: string; refreshToken: string }[] = [];
  revoked: string[] = [];
  projects = new Map<number, FakeProject>();
  mergeRequests: FakeMergeRequest[] = [];
  pipelines: FakePipeline[] = [];
  requests: FakeRequest[] = [];
  private seq = 1;
  private server?: Server;

  static async start(): Promise<FakeGitlab> {
    const fake = new FakeGitlab();
    const server = fake.buildApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    fake.server = server;
    fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return fake;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    const closed = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    server.closeAllConnections();
    await closed;
  }

  reset(): void {
    this.users.clear();
    this.tokens.clear();
    this.refreshTokens.clear();
    this.authCodes.clear();
    this.issued = [];
    this.revoked = [];
    this.projects.clear();
    this.mergeRequests = [];
    this.pipelines = [];
    this.requests = [];
    this.seq = 1;
  }

  addUser(data: { username: string; name?: string; avatar_url?: string | null }): FakeUser {
    const user: FakeUser = { id: this.seq++, username: data.username, name: data.name ?? data.username, avatar_url: data.avatar_url ?? null };
    this.users.set(user.id, user);
    return user;
  }

  issueTokens(user: FakeUser, opts: { expired?: boolean } = {}): { accessToken: string; refreshToken: string } {
    const pair = { accessToken: `access-${randomBytes(8).toString('hex')}`, refreshToken: `refresh-${randomBytes(8).toString('hex')}` };
    this.tokens.set(pair.accessToken, { user, expired: !!opts.expired });
    this.refreshTokens.set(pair.refreshToken, user);
    this.issued.push(pair);
    return pair;
  }

  issueAuthCode(user: FakeUser, codeChallenge: string, redirectUri: string): string {
    const code = `code-${randomBytes(8).toString('hex')}`;
    this.authCodes.set(code, { user, codeChallenge, redirectUri });
    return code;
  }

  addProject(data: {
    id: number;
    path: string;
    defaultBranch?: string;
    members?: FakeUser[];
    ciEnabled?: boolean;
    files?: Record<string, string>;
  }): FakeProject {
    const defaultBranch = data.defaultBranch ?? 'main';
    const commitId = sha();
    const project: FakeProject = {
      id: data.id,
      name: data.path.split('/').pop()!,
      path_with_namespace: data.path,
      web_url: `${this.url}/${data.path}`,
      default_branch: defaultBranch,
      ciEnabled: data.ciEnabled ?? true,
      memberIds: new Set((data.members ?? []).map((m) => m.id)),
      branches: new Map(),
    };
    const files = new Map(Object.entries(data.files ?? {}).map(([path, content]) => [path, { content, lastCommitId: commitId }]));
    project.branches.set(defaultBranch, { name: defaultBranch, commitId, files });
    this.projects.set(project.id, project);
    return project;
  }

  addMember(projectId: number, user: FakeUser): void {
    this.projects.get(projectId)!.memberIds.add(user.id);
  }

  addBranch(projectId: number, name: string, from?: string): FakeBranch {
    const project = this.projects.get(projectId)!;
    const source = project.branches.get(from ?? project.default_branch)!;
    const branch: FakeBranch = { name, commitId: source.commitId, files: new Map([...source.files].map(([k, v]) => [k, { ...v }])) };
    project.branches.set(name, branch);
    return branch;
  }

  branch(projectId: number, name: string): FakeBranch | undefined {
    return this.projects.get(projectId)?.branches.get(name);
  }

  file(projectId: number, branch: string, path: string): FakeFile | undefined {
    return this.branch(projectId, branch)?.files.get(path);
  }

  /** Simulates a push to `branch` that changes one file; returns the new commit id. */
  setFile(projectId: number, branch: string, path: string, content: string): string {
    const b = this.branch(projectId, branch)!;
    const commitId = sha();
    b.files.set(path, { content, lastCommitId: commitId });
    b.commitId = commitId;
    return commitId;
  }

  pipeline(id: number): FakePipeline {
    const pipeline = this.pipelines.find((p) => p.id === id);
    if (!pipeline) throw new Error(`Fake pipeline ${id} does not exist`);
    return pipeline;
  }

  setPipelineStatus(id: number, status: string): void {
    this.pipeline(id).status = status;
  }

  finishPipeline(id: number, status: string, report: FakeTestReport | null, finishedAt = '2026-09-18T10:00:00.000Z'): void {
    const pipeline = this.pipeline(id);
    const project = this.projects.get(pipeline.project_id)!;
    pipeline.status = status;
    pipeline.finished_at = finishedAt;
    pipeline.testReport = report;
    const jobId = 500 + id;
    pipeline.jobs = [{ id: jobId, name: 'ejad-playwright', status, web_url: `${project.web_url}/-/jobs/${jobId}` }];
  }

  requestsTo(pathPart: string, method?: string): FakeRequest[] {
    return this.requests.filter((r) => r.path.includes(pathPart) && (!method || r.method === method));
  }

  private resolveRef(project: FakeProject, ref: string): FakeBranch | undefined {
    return project.branches.get(ref) ?? [...project.branches.values()].find((b) => b.commitId === ref);
  }

  private projectJson(p: FakeProject) {
    return { id: p.id, name: p.name, path_with_namespace: p.path_with_namespace, web_url: p.web_url, default_branch: p.default_branch };
  }

  private branchJson(p: FakeProject, b: FakeBranch) {
    return { name: b.name, default: b.name === p.default_branch, commit: { id: b.commitId } };
  }

  private pipelineJson(p: FakePipeline) {
    return { id: p.id, status: p.status, ref: p.ref, web_url: p.web_url, finished_at: p.finished_at };
  }

  private buildApp() {
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use(express.urlencoded({ extended: false }));
    app.use((req, _res, next) => {
      const [scheme, token] = String(req.headers.authorization ?? '').split(' ');
      this.requests.push({ method: req.method, path: req.path, query: { ...req.query }, token: scheme === 'Bearer' ? token : null, body: req.body });
      next();
    });

    app.post('/oauth/token', (req, res) => {
      const b = req.body as Record<string, string | undefined>;
      if (b.client_id !== this.clientId || b.client_secret !== this.clientSecret) {
        res.status(401).json({ error: 'invalid_client' });
        return;
      }
      let user: FakeUser | undefined;
      if (b.grant_type === 'authorization_code') {
        const grant = this.authCodes.get(b.code ?? '');
        const challenge = createHash('sha256').update(b.code_verifier ?? '').digest('base64url');
        if (!grant || grant.redirectUri !== b.redirect_uri || grant.codeChallenge !== challenge) {
          res.status(400).json(INVALID_GRANT);
          return;
        }
        this.authCodes.delete(b.code!);
        user = grant.user;
      } else if (b.grant_type === 'refresh_token') {
        user = this.refreshTokens.get(b.refresh_token ?? '');
        if (!user) {
          res.status(400).json(INVALID_GRANT);
          return;
        }
        this.refreshTokens.delete(b.refresh_token!);
      } else {
        res.status(400).json({ error: 'unsupported_grant_type' });
        return;
      }
      const t = this.issueTokens(user);
      res.json({
        access_token: t.accessToken,
        token_type: 'Bearer',
        expires_in: 7200,
        refresh_token: t.refreshToken,
        scope: 'api',
        created_at: Math.floor(Date.now() / 1000),
      });
    });

    app.post('/oauth/revoke', (req, res) => {
      const token = String((req.body as Record<string, unknown>).token ?? '');
      this.revoked.push(token);
      this.tokens.delete(token);
      res.json({});
    });

    const api = express.Router();
    api.use((req, res, next) => {
      const [, token] = String(req.headers.authorization ?? '').split(' ');
      const info = token ? this.tokens.get(token) : undefined;
      if (!info) {
        res.status(401).json({ message: '401 Unauthorized' });
        return;
      }
      if (info.expired) {
        res.status(401).json({ error: 'invalid_token', error_description: 'Token is expired. You can either do re-authorization or token refresh.' });
        return;
      }
      res.locals.user = info.user;
      next();
    });

    const userOf = (res: Response) => res.locals.user as FakeUser;
    const project = (req: Request, res: Response): FakeProject | undefined => {
      const p = this.projects.get(Number(req.params.id));
      if (!p || !p.memberIds.has(userOf(res).id)) {
        res.status(404).json({ message: '404 Project Not Found' });
        return undefined;
      }
      return p;
    };
    const pipelineOf = (req: Request, res: Response): FakePipeline | undefined => {
      const p = project(req, res);
      if (!p) return undefined;
      const pipeline = this.pipelines.find((x) => x.id === Number(req.params.pipelineId) && x.project_id === p.id);
      if (!pipeline) res.status(404).json({ message: '404 Not found' });
      return pipeline;
    };

    api.get('/user', (_req, res) => {
      res.json(userOf(res));
    });

    api.get('/projects', (req, res) => {
      const search = String(req.query.search ?? '').toLowerCase();
      res.json(
        [...this.projects.values()]
          .filter((p) => p.memberIds.has(userOf(res).id))
          .filter((p) => p.name.toLowerCase().includes(search) || p.path_with_namespace.toLowerCase().includes(search))
          .map((p) => this.projectJson(p)),
      );
    });

    api.get('/projects/:id', (req, res) => {
      const p = project(req, res);
      if (p) res.json(this.projectJson(p));
    });

    // Always answers recursively (the API only asks for recursive listings).
    api.get('/projects/:id/repository/tree', (req, res) => {
      const p = project(req, res);
      if (!p) return;
      const branch = this.resolveRef(p, String(req.query.ref ?? p.default_branch));
      if (!branch) {
        res.status(404).json({ message: '404 Tree Not Found' });
        return;
      }
      const base = String(req.query.path ?? '').replace(/\/+$/, '');
      const prefix = base ? `${base}/` : '';
      const entries = new Map<string, { id: string; name: string; type: 'tree' | 'blob'; path: string; mode: string }>();
      for (const filePath of branch.files.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const parts = filePath.slice(prefix.length).split('/');
        for (let i = 1; i < parts.length; i++) {
          const dir = prefix + parts.slice(0, i).join('/');
          entries.set(dir, { id: sha(), name: parts[i - 1], type: 'tree', path: dir, mode: '040000' });
        }
        entries.set(filePath, { id: sha(), name: parts[parts.length - 1], type: 'blob', path: filePath, mode: '100644' });
      }
      const all = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
      const perPage = Number(req.query.per_page ?? 20);
      const page = Number(req.query.page ?? 1);
      res.setHeader('x-next-page', page * perPage < all.length ? String(page + 1) : '');
      res.json(all.slice((page - 1) * perPage, page * perPage));
    });

    api.get('/projects/:id/repository/files/:filePath', (req, res) => {
      const p = project(req, res);
      if (!p) return;
      const ref = String(req.query.ref ?? p.default_branch);
      const branch = this.resolveRef(p, ref);
      const path = String(req.params.filePath);
      const file = branch?.files.get(path);
      if (!branch || !file) {
        res.status(404).json({ message: '404 File Not Found' });
        return;
      }
      res.json({
        file_name: path.split('/').pop(),
        file_path: path,
        size: Buffer.byteLength(file.content),
        encoding: 'base64',
        content: Buffer.from(file.content).toString('base64'),
        ref,
        blob_id: sha(),
        commit_id: branch.commitId,
        last_commit_id: file.lastCommitId,
      });
    });

    api.get('/projects/:id/repository/branches', (req, res) => {
      const p = project(req, res);
      if (!p) return;
      const search = String(req.query.search ?? '');
      res.json([...p.branches.values()].filter((b) => b.name.includes(search)).map((b) => this.branchJson(p, b)));
    });

    api.get('/projects/:id/repository/branches/:branch', (req, res) => {
      const p = project(req, res);
      if (!p) return;
      const b = p.branches.get(String(req.params.branch));
      if (!b) {
        res.status(404).json({ message: '404 Branch Not Found' });
        return;
      }
      res.json(this.branchJson(p, b));
    });

    api.post('/projects/:id/repository/commits', (req, res) => {
      const p = project(req, res);
      if (!p) return;
      const body = req.body as {
        branch: string;
        start_branch?: string;
        commit_message: string;
        actions: { action: string; file_path: string; content: string; last_commit_id?: string }[];
      };
      let branch = p.branches.get(body.branch);
      if (!branch) {
        const start = body.start_branch ? p.branches.get(body.start_branch) : undefined;
        if (!start) {
          res.status(400).json({ message: 'You can only create or edit files when you are on a branch' });
          return;
        }
        branch = { name: body.branch, commitId: start.commitId, files: new Map([...start.files].map(([k, v]) => [k, { ...v }])) };
      }
      for (const a of body.actions) {
        const existing = branch.files.get(a.file_path);
        if (a.action === 'create' && existing) {
          res.status(400).json({ message: 'A file with this name already exists' });
          return;
        }
        if (a.action === 'update' && !existing) {
          res.status(400).json({ message: "A file with this name doesn't exist" });
          return;
        }
        if (a.action === 'update' && existing && a.last_commit_id && a.last_commit_id !== existing.lastCommitId) {
          res.status(400).json({ message: 'You are attempting to update a file that has changed since you started editing it.' });
          return;
        }
      }
      const commitId = sha();
      for (const a of body.actions) branch.files.set(a.file_path, { content: a.content, lastCommitId: commitId });
      branch.commitId = commitId;
      p.branches.set(branch.name, branch);
      res.status(201).json({ id: commitId, short_id: commitId.slice(0, 8), title: body.commit_message, web_url: `${p.web_url}/-/commit/${commitId}` });
    });

    api.get('/projects/:id/merge_requests', (req, res) => {
      const p = project(req, res);
      if (!p) return;
      const source = req.query.source_branch === undefined ? undefined : String(req.query.source_branch);
      const state = String(req.query.state ?? 'all');
      res.json(
        this.mergeRequests
          .filter((m) => m.project_id === p.id && (!source || m.source_branch === source) && (state === 'all' || m.state === state))
          .sort((a, b) => b.iid - a.iid),
      );
    });

    api.post('/projects/:id/merge_requests', (req, res) => {
      const p = project(req, res);
      if (!p) return;
      const b = req.body as { source_branch: string; target_branch: string; title: string; description?: string };
      if (this.mergeRequests.some((m) => m.project_id === p.id && m.source_branch === b.source_branch && m.state === 'opened')) {
        res.status(409).json({ message: ['Another open merge request already exists for this source branch'] });
        return;
      }
      const iid = this.mergeRequests.filter((m) => m.project_id === p.id).length + 1;
      const mr: FakeMergeRequest = {
        iid,
        project_id: p.id,
        source_branch: b.source_branch,
        target_branch: b.target_branch,
        title: b.title,
        description: b.description ?? '',
        state: 'opened',
        web_url: `${p.web_url}/-/merge_requests/${iid}`,
      };
      this.mergeRequests.push(mr);
      res.status(201).json(mr);
    });

    api.put('/projects/:id/merge_requests/:iid', (req, res) => {
      const p = project(req, res);
      if (!p) return;
      const mr = this.mergeRequests.find((m) => m.project_id === p.id && m.iid === Number(req.params.iid));
      if (!mr) {
        res.status(404).json({ message: '404 Not found' });
        return;
      }
      const b = req.body as { title?: string; description?: string };
      if (b.title !== undefined) mr.title = b.title;
      if (b.description !== undefined) mr.description = b.description;
      res.json(mr);
    });

    api.post('/projects/:id/pipeline', (req, res) => {
      const p = project(req, res);
      if (!p) return;
      const body = req.body as { ref: string; variables?: { key: string; value: string }[] };
      if (!p.branches.has(body.ref)) {
        res.status(400).json({ message: { base: ['Reference not found'] } });
        return;
      }
      if (!p.ciEnabled) {
        res.status(400).json({
          message: { base: ['Pipeline will not run for the selected trigger. The rules configuration prevented any jobs from being added to the pipeline.'] },
        });
        return;
      }
      const id = this.seq++;
      const pipeline: FakePipeline = {
        id,
        project_id: p.id,
        ref: body.ref,
        status: 'created',
        web_url: `${p.web_url}/-/pipelines/${id}`,
        finished_at: null,
        variables: Object.fromEntries((body.variables ?? []).map((v) => [v.key, v.value])),
        userId: userOf(res).id,
        testReport: null,
        jobs: [],
      };
      this.pipelines.push(pipeline);
      res.status(201).json(this.pipelineJson(pipeline));
    });

    api.get('/projects/:id/pipelines/:pipelineId', (req, res) => {
      const pipeline = pipelineOf(req, res);
      if (pipeline) res.json(this.pipelineJson(pipeline));
    });

    api.get('/projects/:id/pipelines/:pipelineId/test_report', (req, res) => {
      const pipeline = pipelineOf(req, res);
      if (pipeline) res.json(pipeline.testReport ?? EMPTY_REPORT);
    });

    api.get('/projects/:id/pipelines/:pipelineId/jobs', (req, res) => {
      const pipeline = pipelineOf(req, res);
      if (pipeline) res.json(pipeline.jobs);
    });

    app.use('/api/v4', api);
    return app;
  }
}
```

`express` (4.x) is installed through `@nestjs/platform-express`, and `@types/express` is already a dev dependency, so nothing new needs installing. Every handler ends with `return;` instead of `return res…`, so it type-checks against the Express 5 typings.

- [ ] **Step 2: Write the failing client unit test**

`src/modules/gitlab/gitlab-api.service.spec.ts`:
```ts
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
    });
    expect(await api.getFile(token, 7, 'main', 'e2e/missing.ts')).toBeNull();
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
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx jest gitlab-api`
Expected: FAIL with "Cannot find module './gitlab-api.service'".

- [ ] **Step 4: Implement the types, the error helpers and the client**

`src/modules/gitlab/gitlab.types.ts`:
```ts
export interface GitlabUser {
  id: number;
  username: string;
  name: string;
  avatarUrl: string | null;
}

export interface GitlabProject {
  id: number;
  name: string;
  pathWithNamespace: string;
  webUrl: string;
  defaultBranch: string | null;
}

export interface GitlabTreeEntry {
  path: string;
  name: string;
  type: 'blob' | 'tree';
}

export interface GitlabFile {
  path: string;
  content: string;
  size: number;
  lastCommitId: string;
}

export interface GitlabBranch {
  name: string;
  commitId: string;
}

export interface GitlabCommit {
  id: string;
  webUrl: string;
}

export interface CommitAction {
  action: 'create' | 'update';
  filePath: string;
  content: string;
  lastCommitId?: string;
}

export type MergeRequestState = 'opened' | 'closed' | 'locked' | 'merged';

export interface GitlabMergeRequest {
  iid: number;
  title: string;
  description: string;
  state: MergeRequestState;
  sourceBranch: string;
  webUrl: string;
}

export interface GitlabPipeline {
  id: number;
  status: string;
  ref: string;
  webUrl: string;
  finishedAt: string | null;
}

export interface GitlabJob {
  id: number;
  name: string;
  status: string;
  webUrl: string;
}

export interface GitlabTestCase {
  status: string;
  name: string;
  classname: string;
  file: string | null;
  /** Seconds, as reported by GitLab. */
  executionTime: number;
  systemOutput: string | null;
  stackTrace: string | null;
}

export interface GitlabTestSuite {
  name: string;
  cases: GitlabTestCase[];
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

/** Pipeline statuses after which GitLab will not run anything else. */
export const FINAL_PIPELINE_STATUSES: ReadonlySet<string> = new Set(['success', 'failed', 'canceled', 'skipped']);
```

`src/modules/gitlab/gitlab-http-error.ts`:
```ts
import { BadGatewayException, HttpException } from '@nestjs/common';
import { STATUS_CODES } from 'http';

/** A failed GitLab call. status 0 means GitLab could not be reached (network error or timeout). */
export class GitlabHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitlabHttpError';
  }
}

/** GitLab error bodies: { message: string | string[] | Record<string, string[]> } or OAuth { error, error_description }. */
export function gitlabErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const b = body as { message?: unknown; error?: unknown; error_description?: unknown };
    const m = b.message;
    if (typeof m === 'string' && m) return m;
    if (Array.isArray(m) && m.length) return m.map(String).join('; ');
    if (m && typeof m === 'object') {
      const parts = Object.entries(m as Record<string, unknown>).map(([key, value]) => {
        const text = Array.isArray(value) ? value.map(String).join(', ') : String(value);
        return key === 'base' ? text : `${key} ${text}`;
      });
      if (parts.length) return parts.join('; ');
    }
    if (typeof b.error_description === 'string' && b.error_description) return b.error_description;
    if (typeof b.error === 'string' && b.error) return b.error;
  }
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 500);
  return `GitLab responded with HTTP ${status}`;
}

/** Passes GitLab's status and message to the client (401 is handled by the caller before this). */
export function toHttpException(error: GitlabHttpError): HttpException {
  if (error.status === 0 || error.status >= 500) {
    return new BadGatewayException({ message: `GitLab request failed: ${error.message}`, details: { source: 'gitlab' } });
  }
  return new HttpException(
    { statusCode: error.status, error: STATUS_CODES[error.status] ?? 'Error', message: error.message, details: { source: 'gitlab' } },
    error.status,
  );
}
```

`src/modules/gitlab/gitlab-api.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GitlabConfig } from '../../config/configuration';
import { GitlabHttpError, gitlabErrorMessage } from './gitlab-http-error';
import {
  CommitAction,
  GitlabBranch,
  GitlabCommit,
  GitlabFile,
  GitlabJob,
  GitlabMergeRequest,
  GitlabPipeline,
  GitlabProject,
  GitlabTestSuite,
  GitlabTreeEntry,
  GitlabUser,
  MergeRequestState,
  OAuthTokens,
} from './gitlab.types';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TREE_PAGES = 50;
const DEFAULT_TOKEN_TTL_SECONDS = 7200;

type Query = Record<string, string | number | boolean | undefined>;

interface RawProject {
  id: number;
  name: string;
  path_with_namespace: string;
  web_url: string;
  default_branch: string | null;
}
interface RawBranch {
  name: string;
  commit: { id: string };
}
interface RawMergeRequest {
  iid: number;
  title: string;
  description: string | null;
  state: MergeRequestState;
  source_branch: string;
  web_url: string;
}
interface RawPipeline {
  id: number;
  status: string;
  ref: string;
  web_url: string;
  finished_at: string | null;
}
interface RawTestCase {
  status: string;
  name: string;
  classname?: string | null;
  file?: string | null;
  execution_time?: number | null;
  system_output?: string | null;
  stack_trace?: string | null;
}
interface RawTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

const toProject = (p: RawProject): GitlabProject => ({
  id: p.id,
  name: p.name,
  pathWithNamespace: p.path_with_namespace,
  webUrl: p.web_url,
  defaultBranch: p.default_branch ?? null,
});
const toBranch = (b: RawBranch): GitlabBranch => ({ name: b.name, commitId: b.commit.id });
const toMergeRequest = (m: RawMergeRequest): GitlabMergeRequest => ({
  iid: m.iid,
  title: m.title,
  description: m.description ?? '',
  state: m.state,
  sourceBranch: m.source_branch,
  webUrl: m.web_url,
});
const toPipeline = (p: RawPipeline): GitlabPipeline => ({ id: p.id, status: p.status, ref: p.ref, webUrl: p.web_url, finishedAt: p.finished_at ?? null });

/** Thin GitLab REST v4 + OAuth client on Node's fetch. Every REST call takes the acting user's token. */
@Injectable()
export class GitlabApiService {
  constructor(private readonly config: ConfigService) {}

  private get cfg(): GitlabConfig {
    return this.config.getOrThrow<GitlabConfig>('gitlab');
  }

  // ---- OAuth ----

  exchangeCode(code: string, codeVerifier: string): Promise<OAuthTokens> {
    return this.tokenRequest({ grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: this.cfg.redirectUri });
  }

  refreshTokens(refreshToken: string): Promise<OAuthTokens> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, redirect_uri: this.cfg.redirectUri });
  }

  async revokeToken(token: string): Promise<void> {
    await this.form('/oauth/revoke', { token, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret });
  }

  // ---- REST ----

  async getCurrentUser(token: string): Promise<GitlabUser> {
    const u = await this.get<{ id: number; username: string; name: string; avatar_url: string | null }>(token, '/user');
    return { id: u.id, username: u.username, name: u.name, avatarUrl: u.avatar_url ?? null };
  }

  async searchProjects(token: string, search: string): Promise<GitlabProject[]> {
    const projects = await this.get<RawProject[]>(token, '/projects', {
      search,
      membership: true,
      simple: true,
      order_by: 'last_activity_at',
      per_page: 20,
    });
    return projects.map(toProject);
  }

  async getProject(token: string, projectId: number): Promise<GitlabProject> {
    return toProject(await this.get<RawProject>(token, `/projects/${projectId}`));
  }

  async listTree(token: string, projectId: number, ref: string, path: string): Promise<GitlabTreeEntry[]> {
    const entries: GitlabTreeEntry[] = [];
    let page = 1;
    for (let i = 0; i < MAX_TREE_PAGES; i++) {
      const { data, headers } = await this.request<{ path: string; name: string; type: 'blob' | 'tree' }[]>(
        token,
        'GET',
        `/projects/${projectId}/repository/tree`,
        { query: { ref, path, recursive: true, per_page: 100, page } },
      );
      entries.push(...data.map((e) => ({ path: e.path, name: e.name, type: e.type })));
      const next = headers.get('x-next-page');
      if (!next) break;
      page = Number(next);
    }
    return entries;
  }

  async getFile(token: string, projectId: number, ref: string, path: string): Promise<GitlabFile | null> {
    try {
      const f = await this.get<{ file_path: string; size: number; content: string; last_commit_id: string }>(
        token,
        `/projects/${projectId}/repository/files/${encodeURIComponent(path)}`,
        { ref },
      );
      return { path: f.file_path, size: f.size, content: Buffer.from(f.content, 'base64').toString('utf8'), lastCommitId: f.last_commit_id };
    } catch (e) {
      if (e instanceof GitlabHttpError && e.status === 404) return null;
      throw e;
    }
  }

  async getBranch(token: string, projectId: number, name: string): Promise<GitlabBranch | null> {
    try {
      return toBranch(await this.get<RawBranch>(token, `/projects/${projectId}/repository/branches/${encodeURIComponent(name)}`));
    } catch (e) {
      if (e instanceof GitlabHttpError && e.status === 404) return null;
      throw e;
    }
  }

  async listBranches(token: string, projectId: number, search: string): Promise<GitlabBranch[]> {
    const branches = await this.get<RawBranch[]>(token, `/projects/${projectId}/repository/branches`, { search, per_page: 100 });
    return branches.map(toBranch);
  }

  async createCommit(
    token: string,
    projectId: number,
    input: { branch: string; startBranch?: string; message: string; actions: CommitAction[] },
  ): Promise<GitlabCommit> {
    const commit = await this.send<{ id: string; web_url: string }>(token, 'POST', `/projects/${projectId}/repository/commits`, {
      branch: input.branch,
      start_branch: input.startBranch,
      commit_message: input.message,
      actions: input.actions.map((a) => ({ action: a.action, file_path: a.filePath, content: a.content, last_commit_id: a.lastCommitId })),
    });
    return { id: commit.id, webUrl: commit.web_url };
  }

  async listMergeRequests(
    token: string,
    projectId: number,
    filter: { sourceBranch: string; state: 'opened' | 'all' },
  ): Promise<GitlabMergeRequest[]> {
    const list = await this.get<RawMergeRequest[]>(token, `/projects/${projectId}/merge_requests`, {
      source_branch: filter.sourceBranch,
      state: filter.state,
      order_by: 'created_at',
      sort: 'desc',
      per_page: 20,
    });
    return list.map(toMergeRequest);
  }

  async createMergeRequest(
    token: string,
    projectId: number,
    input: { sourceBranch: string; targetBranch: string; title: string; description: string },
  ): Promise<GitlabMergeRequest> {
    return toMergeRequest(
      await this.send<RawMergeRequest>(token, 'POST', `/projects/${projectId}/merge_requests`, {
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title: input.title,
        description: input.description,
        remove_source_branch: true,
      }),
    );
  }

  async updateMergeRequest(token: string, projectId: number, iid: number, input: { description: string }): Promise<GitlabMergeRequest> {
    return toMergeRequest(await this.send<RawMergeRequest>(token, 'PUT', `/projects/${projectId}/merge_requests/${iid}`, input));
  }

  async createPipeline(token: string, projectId: number, ref: string, variables: Record<string, string>): Promise<GitlabPipeline> {
    return toPipeline(
      await this.send<RawPipeline>(token, 'POST', `/projects/${projectId}/pipeline`, {
        ref,
        variables: Object.entries(variables).map(([key, value]) => ({ key, value, variable_type: 'env_var' })),
      }),
    );
  }

  async getPipeline(token: string, projectId: number, pipelineId: number): Promise<GitlabPipeline> {
    return toPipeline(await this.get<RawPipeline>(token, `/projects/${projectId}/pipelines/${pipelineId}`));
  }

  async getTestReport(token: string, projectId: number, pipelineId: number): Promise<GitlabTestSuite[]> {
    const report = await this.get<{ test_suites?: { name: string; test_cases?: RawTestCase[] }[] }>(
      token,
      `/projects/${projectId}/pipelines/${pipelineId}/test_report`,
    );
    return (report.test_suites ?? []).map((s) => ({
      name: s.name,
      cases: (s.test_cases ?? []).map((c) => ({
        status: c.status,
        name: c.name,
        classname: c.classname ?? '',
        file: c.file ?? null,
        executionTime: c.execution_time ?? 0,
        systemOutput: c.system_output ?? null,
        stackTrace: c.stack_trace ?? null,
      })),
    }));
  }

  async listPipelineJobs(token: string, projectId: number, pipelineId: number): Promise<GitlabJob[]> {
    const jobs = await this.get<{ id: number; name: string; status: string; web_url: string }[]>(
      token,
      `/projects/${projectId}/pipelines/${pipelineId}/jobs`,
      { per_page: 100 },
    );
    return jobs.map((j) => ({ id: j.id, name: j.name, status: j.status, webUrl: j.web_url }));
  }

  // ---- transport ----

  private async get<T>(token: string, path: string, query?: Query): Promise<T> {
    return (await this.request<T>(token, 'GET', path, { query })).data;
  }

  private async send<T>(token: string, method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> {
    return (await this.request<T>(token, method, path, { body })).data;
  }

  private request<T>(
    token: string,
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<{ data: T; headers: Headers }> {
    const url = new URL(`${this.cfg.url}/api/v4${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    return this.execute<T>(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  }

  private async tokenRequest(params: Record<string, string>): Promise<OAuthTokens> {
    const data = await this.form<RawTokenResponse>('/oauth/token', { ...params, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret });
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + (data.expires_in ?? DEFAULT_TOKEN_TTL_SECONDS) * 1000),
    };
  }

  private async form<T>(path: string, params: Record<string, string>): Promise<T> {
    const { data } = await this.execute<T>(new URL(`${this.cfg.url}${path}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
    });
    return data;
  }

  private async execute<T>(url: URL, init: RequestInit): Promise<{ data: T; headers: Headers }> {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      throw new GitlabHttpError(0, `GitLab is unreachable (${(e as Error).message})`);
    }
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) throw new GitlabHttpError(res.status, gitlabErrorMessage(body, res.status));
    return { data: body as T, headers: res.headers };
  }
}
```

- [ ] **Step 5: Let `createTestApp` override environment variables**

In `test/utils/test-app.ts`, replace `createTestApp` with the version below and add `applyEnv` under it. `resetDb`, `binaryParser` and `makeXlsx` stay the same:
```ts
/**
 * Builds the app. `env` overrides process.env while the Nest module is compiled: the config
 * factory (ConfigModule `load`) reads process.env at that moment. `undefined` removes a variable.
 * Previous values are restored afterwards, so other test files are unaffected.
 */
export async function createTestApp(env: Record<string, string | undefined> = {}): Promise<TestContext> {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  applyEnv(env);
  try {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    return {
      app,
      prisma: app.get(PrismaService),
      http: () => request(app.getHttpServer()),
    };
  } finally {
    applyEnv(previous);
  }
}

function applyEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest gitlab-api && npm run typecheck && npm test && npm run test:e2e`
Expected: 7 client tests pass. Then `Tests: 71 passed, 71 total` (unit) and `Tests: 74 passed, 74 total` (e2e), with no warnings and no open-handle message.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test: fake GitLab server and fetch-based GitLab client

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: GitLab OAuth connection, status and project search

**Files:**
- Create: `src/modules/gitlab/gitlab-connection.service.ts`, `src/modules/gitlab/gitlab-enabled.guard.ts`, `src/modules/gitlab/gitlab.controller.ts`, `src/modules/gitlab/gitlab.module.ts`
- Create: `test/utils/gitlab.ts`
- Modify: `src/app.module.ts` (import `GitlabModule`)
- Test: `test/gitlab-connection.e2e-spec.ts`, `test/gitlab-disabled.e2e-spec.ts`

**Interfaces:**
- Consumes: `TokenCipher`, `sha256Hex`, `GitlabConfig` (Task 1); `GitlabApiService`, `GitlabHttpError`, `toHttpException`, `FakeGitlab`, `createTestApp(env)` (Task 2); `CurrentUser`, `Public`, `Roles`, factories.
- Produces:
  - `GitlabConnectionService`. `status(userId): Promise<GitlabStatus>`. `startOAuth(userId): Promise<{ authorizeUrl: string }>`. `completeOAuth({ code?, state?, error? }): Promise<string>` returns the redirect URL: `WEB_URL/profile?gitlab=connected`, or `WEB_URL/profile?gitlab=error&reason=invalid_state|denied|exchange_failed`. `disconnect(userId): Promise<void>`. `requireConnection(userId): Promise<GitlabConnection>`, which throws 403 `GITLAB_NOT_CONNECTED` / `GITLAB_NEEDS_RECONNECT`. `accessToken(userId): Promise<string>` refreshes when the token expires within 60 s; a failed refresh sets NEEDS_RECONNECT and throws 403. `withToken<T>(userId, fn: (token: string) => Promise<T>): Promise<T>`: a GitLab 401 sets NEEDS_RECONNECT and throws 403; any other `GitlabHttpError` goes through `toHttpException`. `markNeedsReconnect(userId): Promise<void>`.
  - `GitlabStatus { enabled: boolean; connection: { username: string; avatarUrl: string | null; state: GitlabConnectionState } | null }`. Constants `GITLAB_NOT_CONNECTED`, `GITLAB_NEEDS_RECONNECT`.
  - `GitlabEnabledGuard` throws 404 `GitLab integration is not configured` when disabled. `GitlabModule` exports `GitlabApiService`, `GitlabConnectionService`, `GitlabEnabledGuard`, `TokenCipher`.
  - Routes: `GET /api/gitlab/status` (always on); `GET /api/gitlab/oauth/start` → `{ authorizeUrl }`; `GET /api/gitlab/oauth/callback?code&state[&error]` (public) → 302; `DELETE /api/gitlab/connection` → 204; `GET /api/gitlab/projects?search=` (ADMIN) → `{ id, name, pathWithNamespace, webUrl, defaultBranch }[]`.
  - Test helpers (test/utils/gitlab.ts): `createGitlabTestApp(env?): Promise<{ ctx: TestContext; fake: FakeGitlab }>`; `seedGitlabConnection(ctx, fake, userId, { username?, gitlabUser?, expired?, state? }?): Promise<{ gitlabUser: FakeUser; accessToken: string; refreshToken: string }>`; `seedLinkedProject(ctx, fake, createdById, members: FakeUser[], { ciEnabled? }?): Promise<{ project: Project; glProject: FakeProject }>` (GitLab project id `101`, `mobile/ninja-store`, default branch `main`, testsPath `e2e`); `GITLAB_PROJECT_ID = 101`; `LOGIN_SPEC`, `CART_SPEC`, `SAMPLE_FILES`.

- [ ] **Step 1: Write the GitLab test helpers**

`test/utils/gitlab.ts`:
```ts
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
```

- [ ] **Step 2: Write the failing e2e tests**

`test/gitlab-connection.e2e-spec.ts`:
```ts
import { createHash } from 'crypto';
import { TokenCipher } from '../src/common/crypto/token-cipher';
import { FakeGitlab } from './utils/fake-gitlab';
import { seedActors } from './utils/factories';
import { createGitlabTestApp, seedGitlabConnection } from './utils/gitlab';
import { resetDb, TestContext } from './utils/test-app';

const REDIRECT_URI = 'http://localhost:3000/api/gitlab/oauth/callback';

describe('GitLab connection (e2e)', () => {
  let ctx: TestContext;
  let fake: FakeGitlab;
  let actors: Awaited<ReturnType<typeof seedActors>>;

  beforeAll(async () => {
    ({ ctx, fake } = await createGitlabTestApp());
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    fake.reset();
    actors = await seedActors(ctx);
  });
  afterAll(async () => {
    await ctx.app.close();
    await fake.close();
  });

  const startOAuth = async () => {
    const res = await ctx.http().get('/api/gitlab/oauth/start').set(actors.testerAuth).expect(200);
    return new URL(res.body.authorizeUrl as string);
  };

  it('reports the connection status', async () => {
    const before = await ctx.http().get('/api/gitlab/status').set(actors.testerAuth).expect(200);
    expect(before.body).toEqual({ enabled: true, connection: null });
    await seedGitlabConnection(ctx, fake, actors.tester.id, { username: 'tess' });
    const after = await ctx.http().get('/api/gitlab/status').set(actors.testerAuth).expect(200);
    expect(after.body).toEqual({ enabled: true, connection: { username: 'tess', avatarUrl: null, state: 'ACTIVE' } });
  });

  it('starts OAuth with PKCE and a hashed, user-bound state', async () => {
    const url = await startOAuth();
    expect(`${url.origin}${url.pathname}`).toBe(`${fake.url}/oauth/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'test-client',
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'api',
      code_challenge_method: 'S256',
    });
    const state = url.searchParams.get('state')!;
    const row = await ctx.prisma.gitlabOAuthState.findFirstOrThrow();
    expect(row.userId).toBe(actors.tester.id);
    expect(row.stateHash).toBe(createHash('sha256').update(state).digest('hex'));
    expect(row.codeVerifierEnc.startsWith('v1:')).toBe(true);
    const ttl = row.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);
  });

  it('completes the callback, stores encrypted tokens and redirects to the web app', async () => {
    const url = await startOAuth();
    const gitlabUser = fake.addUser({ username: 'tess', avatar_url: 'https://git.test/tess.png' });
    const code = fake.issueAuthCode(gitlabUser, url.searchParams.get('code_challenge')!, REDIRECT_URI);
    const state = url.searchParams.get('state')!;

    const res = await ctx.http().get('/api/gitlab/oauth/callback').query({ code, state }).expect(302);
    expect(res.headers.location).toBe('http://localhost:3001/profile?gitlab=connected');

    const conn = await ctx.prisma.gitlabConnection.findUniqueOrThrow({ where: { userId: actors.tester.id } });
    expect(conn).toMatchObject({ username: 'tess', gitlabUserId: gitlabUser.id, avatarUrl: 'https://git.test/tess.png', state: 'ACTIVE' });
    const issued = fake.issued.at(-1)!;
    expect(conn.accessTokenEnc).not.toContain(issued.accessToken);
    expect(ctx.app.get(TokenCipher).decrypt(conn.accessTokenEnc)).toBe(issued.accessToken);
    expect(ctx.app.get(TokenCipher).decrypt(conn.refreshTokenEnc)).toBe(issued.refreshToken);
    expect(conn.expiresAt.getTime()).toBeGreaterThan(Date.now() + 7_000_000);

    // The state is single-use.
    const again = await ctx.http().get('/api/gitlab/oauth/callback').query({ code, state }).expect(302);
    expect(again.headers.location).toBe('http://localhost:3001/profile?gitlab=error&reason=invalid_state');
  });

  it('rejects unknown and expired states without calling GitLab', async () => {
    const unknown = await ctx.http().get('/api/gitlab/oauth/callback').query({ code: 'x', state: 'forged' }).expect(302);
    expect(unknown.headers.location).toBe('http://localhost:3001/profile?gitlab=error&reason=invalid_state');

    const url = await startOAuth();
    await ctx.prisma.gitlabOAuthState.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await ctx.http().get('/api/gitlab/oauth/callback').query({ code: 'x', state: url.searchParams.get('state')! }).expect(302);
    expect(expired.headers.location).toBe('http://localhost:3001/profile?gitlab=error&reason=invalid_state');
    expect(fake.requestsTo('/oauth/token')).toHaveLength(0);
  });

  it('reports a denied authorization', async () => {
    const url = await startOAuth();
    const res = await ctx.http().get('/api/gitlab/oauth/callback').query({ error: 'access_denied', state: url.searchParams.get('state')! }).expect(302);
    expect(res.headers.location).toBe('http://localhost:3001/profile?gitlab=error&reason=denied');
    expect(await ctx.prisma.gitlabConnection.count()).toBe(0);
  });

  it('disconnects, revoking the token at GitLab', async () => {
    const { accessToken } = await seedGitlabConnection(ctx, fake, actors.tester.id);
    await ctx.http().delete('/api/gitlab/connection').set(actors.testerAuth).expect(204);
    expect(fake.revoked).toEqual([accessToken]);
    expect(await ctx.prisma.gitlabConnection.count()).toBe(0);
    const status = await ctx.http().get('/api/gitlab/status').set(actors.testerAuth).expect(200);
    expect(status.body.connection).toBeNull();
  });

  it('searches GitLab projects for admins only', async () => {
    const { gitlabUser } = await seedGitlabConnection(ctx, fake, actors.admin.id, { username: 'admin' });
    fake.addProject({ id: 101, path: 'mobile/ninja-store', members: [gitlabUser] });
    fake.addProject({ id: 102, path: 'secret/ninja-admin', members: [] });

    const res = await ctx.http().get('/api/gitlab/projects').query({ search: 'ninja' }).set(actors.adminAuth).expect(200);
    expect(res.body).toEqual([
      { id: 101, name: 'ninja-store', pathWithNamespace: 'mobile/ninja-store', webUrl: `${fake.url}/mobile/ninja-store`, defaultBranch: 'main' },
    ]);
    await ctx.http().get('/api/gitlab/projects').set(actors.testerAuth).expect(403);
  });

  it('asks users without a connection to connect GitLab', async () => {
    const res = await ctx.http().get('/api/gitlab/projects').set(actors.adminAuth).expect(403);
    expect(res.body).toEqual({
      statusCode: 403,
      error: 'Forbidden',
      message: 'Connect GitLab to use automation',
      details: { code: 'GITLAB_NOT_CONNECTED' },
    });
  });

  it('refreshes an expired token before calling GitLab', async () => {
    const { gitlabUser, accessToken } = await seedGitlabConnection(ctx, fake, actors.admin.id, { username: 'admin', expired: true });
    fake.addProject({ id: 101, path: 'mobile/ninja-store', members: [gitlabUser] });

    await ctx.http().get('/api/gitlab/projects').set(actors.adminAuth).expect(200);
    expect(fake.requestsTo('/oauth/token')).toHaveLength(1);
    const conn = await ctx.prisma.gitlabConnection.findUniqueOrThrow({ where: { userId: actors.admin.id } });
    const newToken = ctx.app.get(TokenCipher).decrypt(conn.accessTokenEnc);
    expect(newToken).not.toBe(accessToken);
    expect(fake.requestsTo('/api/v4/projects').at(-1)!.token).toBe(newToken);
    expect(conn.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3_600_000);
  });

  it('marks the connection NEEDS_RECONNECT when the refresh fails', async () => {
    await seedGitlabConnection(ctx, fake, actors.admin.id, { username: 'admin', expired: true });
    fake.refreshTokens.clear();

    const res = await ctx.http().get('/api/gitlab/projects').set(actors.adminAuth).expect(403);
    expect(res.body.details).toEqual({ code: 'GITLAB_NEEDS_RECONNECT' });
    const status = await ctx.http().get('/api/gitlab/status').set(actors.adminAuth).expect(200);
    expect(status.body.connection).toMatchObject({ username: 'admin', state: 'NEEDS_RECONNECT' });
  });

  it('marks the connection NEEDS_RECONNECT when GitLab answers 401', async () => {
    const { accessToken } = await seedGitlabConnection(ctx, fake, actors.admin.id, { username: 'admin' });
    fake.tokens.delete(accessToken);

    const res = await ctx.http().get('/api/gitlab/projects').set(actors.adminAuth).expect(403);
    expect(res.body.message).toBe('Your GitLab connection expired – reconnect GitLab to continue');
    const conn = await ctx.prisma.gitlabConnection.findUniqueOrThrow({ where: { userId: actors.admin.id } });
    expect(conn.state).toBe('NEEDS_RECONNECT');
  });
});
```

`test/gitlab-disabled.e2e-spec.ts`:
```ts
import { seedActors } from './utils/factories';
import { createTestApp, resetDb, TestContext } from './utils/test-app';

describe('GitLab disabled (e2e)', () => {
  let ctx: TestContext;
  let actors: Awaited<ReturnType<typeof seedActors>>;

  beforeAll(async () => {
    // Explicitly unset, even if a developer's .env configures GitLab.
    ctx = await createTestApp({ GITLAB_URL: undefined });
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    actors = await seedActors(ctx);
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  const expectHidden = async (method: 'get' | 'put' | 'post' | 'delete', url: string, body: object = {}) => {
    const req = ctx.http()[method](url).set(actors.adminAuth);
    const res = await (method === 'get' || method === 'delete' ? req : req.send(body)).expect(404);
    expect(res.body.message).toBe('GitLab integration is not configured');
  };

  it('reports GitLab as disabled', async () => {
    const res = await ctx.http().get('/api/gitlab/status').set(actors.testerAuth).expect(200);
    expect(res.body).toEqual({ enabled: false, connection: null });
  });

  it('hides OAuth, connection and project search endpoints', async () => {
    await expectHidden('get', '/api/gitlab/oauth/start');
    await expectHidden('delete', '/api/gitlab/connection');
    await expectHidden('get', '/api/gitlab/projects?search=ninja');
    await ctx.http().get('/api/gitlab/oauth/callback').query({ code: 'a', state: 'b' }).expect(404);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npm run test:e2e -- gitlab-`
Expected: FAIL. `GET /api/gitlab/status` answers 404 ("Cannot GET /api/gitlab/status"), and `ctx.app.get(TokenCipher)` throws.

- [ ] **Step 4: Implement the guard and the connection service**

`src/modules/gitlab/gitlab-enabled.guard.ts`:
```ts
import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GitlabConfig } from '../../config/configuration';

/** GitLab features are hidden (404) when GITLAB_URL is not configured. */
@Injectable()
export class GitlabEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    if (!this.config.getOrThrow<GitlabConfig>('gitlab').enabled) {
      throw new NotFoundException('GitLab integration is not configured');
    }
    return true;
  }
}
```

`src/modules/gitlab/gitlab-connection.service.ts`:
```ts
import { BadGatewayException, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GitlabConnection, GitlabConnectionState } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { sha256Hex, TokenCipher } from '../../common/crypto/token-cipher';
import { GitlabConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { GitlabApiService } from './gitlab-api.service';
import { GitlabHttpError, toHttpException } from './gitlab-http-error';
import { GitlabUser, OAuthTokens } from './gitlab.types';

export const GITLAB_NOT_CONNECTED = 'GITLAB_NOT_CONNECTED';
export const GITLAB_NEEDS_RECONNECT = 'GITLAB_NEEDS_RECONNECT';

const STATE_TTL_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 60_000;

export interface GitlabStatus {
  enabled: boolean;
  connection: { username: string; avatarUrl: string | null; state: GitlabConnectionState } | null;
}

const notConnected = () =>
  new ForbiddenException({ message: 'Connect GitLab to use automation', details: { code: GITLAB_NOT_CONNECTED } });
const needsReconnect = () =>
  new ForbiddenException({
    message: 'Your GitLab connection expired – reconnect GitLab to continue',
    details: { code: GITLAB_NEEDS_RECONNECT },
  });

@Injectable()
export class GitlabConnectionService {
  /** One refresh in flight per user: GitLab refresh tokens are single-use (single API instance). */
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly api: GitlabApiService,
    private readonly cipher: TokenCipher,
    private readonly config: ConfigService,
  ) {}

  private get cfg(): GitlabConfig {
    return this.config.getOrThrow<GitlabConfig>('gitlab');
  }

  async status(userId: string): Promise<GitlabStatus> {
    if (!this.cfg.enabled) return { enabled: false, connection: null };
    const c = await this.prisma.gitlabConnection.findUnique({ where: { userId } });
    return { enabled: true, connection: c ? { username: c.username, avatarUrl: c.avatarUrl, state: c.state } : null };
  }

  /** Authorization code flow with PKCE; the random state is stored hashed and bound to the user. */
  async startOAuth(userId: string): Promise<{ authorizeUrl: string }> {
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const now = new Date();
    await this.prisma.gitlabOAuthState.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { userId, usedAt: { not: null } }] },
    });
    await this.prisma.gitlabOAuthState.create({
      data: {
        userId,
        stateHash: sha256Hex(state),
        codeVerifierEnc: this.cipher.encrypt(verifier),
        expiresAt: new Date(now.getTime() + STATE_TTL_MS),
      },
    });
    const url = new URL(`${this.cfg.url}/oauth/authorize`);
    url.searchParams.set('client_id', this.cfg.clientId);
    url.searchParams.set('redirect_uri', this.cfg.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'api');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { authorizeUrl: url.toString() };
  }

  /** Handles the browser redirect from GitLab and returns where to send the browser next. */
  async completeOAuth(params: { code?: string; state?: string; error?: string }): Promise<string> {
    const fail = (reason: string) => `${this.cfg.webUrl}/profile?gitlab=error&reason=${reason}`;
    if (!params.state) return fail('invalid_state');
    const row = await this.prisma.gitlabOAuthState.findUnique({ where: { stateHash: sha256Hex(params.state) } });
    if (!row) return fail('invalid_state');
    // Claim the state atomically: only one callback can use it, and only before it expires.
    const now = new Date();
    const claimed = await this.prisma.gitlabOAuthState.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return fail('invalid_state');
    if (params.error || !params.code) return fail('denied');

    let tokens: OAuthTokens;
    let gitlabUser: GitlabUser;
    try {
      tokens = await this.api.exchangeCode(params.code, this.cipher.decrypt(row.codeVerifierEnc));
      gitlabUser = await this.api.getCurrentUser(tokens.accessToken);
    } catch (e) {
      if (e instanceof GitlabHttpError) return fail('exchange_failed');
      throw e;
    }
    const data = {
      gitlabUserId: gitlabUser.id,
      username: gitlabUser.username,
      avatarUrl: gitlabUser.avatarUrl,
      accessTokenEnc: this.cipher.encrypt(tokens.accessToken),
      refreshTokenEnc: this.cipher.encrypt(tokens.refreshToken),
      expiresAt: tokens.expiresAt,
      state: GitlabConnectionState.ACTIVE,
    };
    await this.prisma.gitlabConnection.upsert({ where: { userId: row.userId }, create: { userId: row.userId, ...data }, update: data });
    return `${this.cfg.webUrl}/profile?gitlab=connected`;
  }

  async disconnect(userId: string): Promise<void> {
    const connection = await this.prisma.gitlabConnection.findUnique({ where: { userId } });
    if (!connection) return;
    try {
      await this.api.revokeToken(this.cipher.decrypt(connection.accessTokenEnc));
    } catch {
      // Best effort: the token is deleted locally either way.
    }
    await this.prisma.gitlabConnection.deleteMany({ where: { userId } });
  }

  async requireConnection(userId: string): Promise<GitlabConnection> {
    const connection = await this.prisma.gitlabConnection.findUnique({ where: { userId } });
    if (!connection) throw notConnected();
    if (connection.state !== GitlabConnectionState.ACTIVE) throw needsReconnect();
    return connection;
  }

  /** A valid access token for the user, refreshed first when it expires within a minute. */
  async accessToken(userId: string): Promise<string> {
    const connection = await this.requireConnection(userId);
    if (connection.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) {
      return this.cipher.decrypt(connection.accessTokenEnc);
    }
    const pending = this.refreshing.get(userId);
    if (pending) return pending;
    const refresh = this.refresh(connection).finally(() => this.refreshing.delete(userId));
    this.refreshing.set(userId, refresh);
    return refresh;
  }

  /** Runs GitLab calls with the user's token and maps GitLab failures to HTTP errors for the client. */
  async withToken<T>(userId: string, fn: (token: string) => Promise<T>): Promise<T> {
    const token = await this.accessToken(userId);
    try {
      return await fn(token);
    } catch (e) {
      if (!(e instanceof GitlabHttpError)) throw e;
      if (e.status === 401) {
        await this.markNeedsReconnect(userId);
        throw needsReconnect();
      }
      throw toHttpException(e);
    }
  }

  async markNeedsReconnect(userId: string): Promise<void> {
    await this.prisma.gitlabConnection.updateMany({ where: { userId }, data: { state: GitlabConnectionState.NEEDS_RECONNECT } });
  }

  private async refresh(connection: GitlabConnection): Promise<string> {
    try {
      const tokens = await this.api.refreshTokens(this.cipher.decrypt(connection.refreshTokenEnc));
      await this.prisma.gitlabConnection.update({
        where: { id: connection.id },
        data: {
          accessTokenEnc: this.cipher.encrypt(tokens.accessToken),
          refreshTokenEnc: this.cipher.encrypt(tokens.refreshToken),
          expiresAt: tokens.expiresAt,
          state: GitlabConnectionState.ACTIVE,
        },
      });
      return tokens.accessToken;
    } catch (e) {
      if (e instanceof GitlabHttpError && e.status > 0 && e.status < 500) {
        await this.markNeedsReconnect(connection.userId);
        throw needsReconnect();
      }
      if (e instanceof GitlabHttpError) throw new BadGatewayException({ message: `GitLab request failed: ${e.message}`, details: { source: 'gitlab' } });
      throw e;
    }
  }
}
```

- [ ] **Step 5: Implement the controller and the module**

`src/modules/gitlab/gitlab.controller.ts`:
```ts
import { Controller, Delete, Get, HttpCode, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { GitlabApiService } from './gitlab-api.service';
import { GitlabConnectionService } from './gitlab-connection.service';
import { GitlabEnabledGuard } from './gitlab-enabled.guard';

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

@ApiTags('GitLab')
@ApiBearerAuth()
@Controller('gitlab')
export class GitlabController {
  constructor(
    private readonly connections: GitlabConnectionService,
    private readonly api: GitlabApiService,
  ) {}

  /** Always available, so the web app can tell whether GitLab is enabled at all. */
  @Get('status')
  status(@CurrentUser() user: AuthUser) {
    return this.connections.status(user.id);
  }

  @UseGuards(GitlabEnabledGuard)
  @Get('oauth/start')
  start(@CurrentUser() user: AuthUser) {
    return this.connections.startOAuth(user.id);
  }

  @Public()
  @UseGuards(GitlabEnabledGuard)
  @Get('oauth/callback')
  async callback(
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Query('error') error: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const target = await this.connections.completeOAuth({ code: asString(code), state: asString(state), error: asString(error) });
    res.redirect(302, target);
  }

  @UseGuards(GitlabEnabledGuard)
  @Delete('connection')
  @HttpCode(204)
  disconnect(@CurrentUser() user: AuthUser): Promise<void> {
    return this.connections.disconnect(user.id);
  }

  @UseGuards(GitlabEnabledGuard)
  @Roles(Role.ADMIN)
  @ApiQuery({ name: 'search', required: false })
  @Get('projects')
  searchProjects(@Query('search') search: unknown, @CurrentUser() user: AuthUser) {
    return this.connections.withToken(user.id, (token) => this.api.searchProjects(token, (asString(search) ?? '').trim()));
  }
}
```

`src/modules/gitlab/gitlab.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { TokenCipher } from '../../common/crypto/token-cipher';
import { GitlabConfig } from '../../config/configuration';
import { GitlabApiService } from './gitlab-api.service';
import { GitlabConnectionService } from './gitlab-connection.service';
import { GitlabEnabledGuard } from './gitlab-enabled.guard';
import { GitlabController } from './gitlab.controller';

@Module({
  controllers: [GitlabController],
  providers: [
    GitlabApiService,
    GitlabConnectionService,
    GitlabEnabledGuard,
    {
      provide: TokenCipher,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const cfg = config.getOrThrow<GitlabConfig>('gitlab');
        // With GitLab disabled nothing is ever encrypted; a throwaway key keeps the provider constructible.
        return new TokenCipher(cfg.enabled ? cfg.tokenEncryptionKey : randomBytes(32).toString('base64'));
      },
    },
  ],
  exports: [GitlabApiService, GitlabConnectionService, GitlabEnabledGuard, TokenCipher],
})
export class GitlabModule {}
```

In `src/app.module.ts`, import `GitlabModule` from `./modules/gitlab/gitlab.module` and add it to `imports` after `ReportsModule`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test:e2e -- gitlab- && npm run typecheck && npm test && npm run test:e2e`
Expected: `gitlab-connection` 11 and `gitlab-disabled` 2 tests pass. Then unit `Tests: 71 passed`, and e2e `Tests: 87 passed, 87 total`, with no warnings.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: GitLab OAuth connection with PKCE, encrypted tokens and refresh

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Path rules and the repository link

**Files:**
- Create: `src/modules/automation/paths.ts`, `src/modules/automation/dto/link-repository.dto.ts`, `src/modules/automation/repository.service.ts`, `src/modules/automation/repository.controller.ts`, `src/modules/automation/automation.module.ts`
- Modify: `src/app.module.ts` (import `AutomationModule`), `test/gitlab-disabled.e2e-spec.ts` (one more test)
- Test: `src/modules/automation/paths.spec.ts`, `test/repository.e2e-spec.ts`

**Interfaces:**
- Consumes: `GitlabConnectionService.withToken`, `GitlabApiService.getProject/getBranch`, `GitlabEnabledGuard`, `GitlabModule` (Task 3); `ProjectsService.requireProject`; `IsOptionalNonNull`; test helpers (Task 3).
- Produces:
  - `paths.ts`: `BRANCH_NAME_RE: RegExp`, `WORK_BRANCH_PREFIX = 'tests/'`, `normalizeRepoPath(raw: string): string`, `resolveInTestsPath(testsPath: string, raw: string): string`, `resolveEditablePath(testsPath: string, raw: string): string`, `workBranchPrefix(gitlabUsername: string): string` (e.g. `tests/tess-`), `workBranchName(gitlabUsername: string, workName: string): string`. They throw `BadRequestException` with these messages: `Path is required`, `Path contains invalid characters`, `Path must not contain "." or ".." segments`, `Path must be inside the tests folder "<testsPath>"`, `Only .ts and .js files can be edited (for example login.spec.ts)`, `The work name must contain letters or digits`.
  - `REPOSITORY_SELECT` (`id, gitlabProjectId, gitlabPath, gitlabWebUrl, defaultBranch, testsPath, playwrightConfigPath`). `RepositoryService.link(projectId, dto, user)`, `RepositoryService.unlink(projectId)`.
  - `PUT /api/projects/:projectId/repository` (ADMIN) with `{ gitlabProjectId: number, testsPath: string, defaultBranch?: string, playwrightConfigPath?: string }` → 200 with the `REPOSITORY_SELECT` shape. `DELETE /api/projects/:projectId/repository` (ADMIN) → 204. `GET /api/projects/:key` now also returns the repository fields (they are Project columns).
  - `AutomationModule` (imports `GitlabModule`, `ProjectsModule`).

- [ ] **Step 1: Write the failing path-rule unit tests**

`src/modules/automation/paths.spec.ts`:
```ts
import { BRANCH_NAME_RE, normalizeRepoPath, resolveEditablePath, resolveInTestsPath, workBranchName, workBranchPrefix } from './paths';

describe('repository path rules', () => {
  it('normalizes separators and surrounding slashes', () => {
    expect(normalizeRepoPath(' /e2e\\auth//login.spec.ts/ ')).toBe('e2e/auth/login.spec.ts');
  });

  it('rejects dot segments and empty paths', () => {
    expect(() => normalizeRepoPath('../etc/passwd')).toThrow('Path must not contain "." or ".." segments');
    expect(() => normalizeRepoPath('e2e/./x.ts')).toThrow('Path must not contain "." or ".." segments');
    expect(() => normalizeRepoPath('  / ')).toThrow('Path is required');
  });

  it('accepts the tests folder itself and anything below it', () => {
    expect(resolveInTestsPath('e2e', 'e2e')).toBe('e2e');
    expect(resolveInTestsPath('e2e', '/e2e/auth/login.spec.ts')).toBe('e2e/auth/login.spec.ts');
  });

  it('rejects paths outside the tests folder', () => {
    expect(() => resolveInTestsPath('e2e', 'src/app.ts')).toThrow('Path must be inside the tests folder "e2e"');
    expect(() => resolveInTestsPath('e2e', 'e2e-other/x.spec.ts')).toThrow('Path must be inside the tests folder "e2e"');
    expect(() => resolveInTestsPath('e2e', 'e2e/../src/app.ts')).toThrow('Path must not contain "." or ".." segments');
  });

  it('only allows editing .ts and .js files', () => {
    for (const ok of ['e2e/a.spec.ts', 'e2e/a.test.ts', 'e2e/helpers.ts', 'e2e/legacy.js']) {
      expect(resolveEditablePath('e2e', ok)).toBe(ok);
    }
    expect(() => resolveEditablePath('e2e', 'e2e/README.md')).toThrow('Only .ts and .js files can be edited (for example login.spec.ts)');
  });

  it('builds work branch names from the GitLab username and a work name', () => {
    expect(workBranchName('Tess.Dev', 'Login fixes!')).toBe('tests/tess.dev-login-fixes');
    expect(workBranchName('tess', 'Café  Checkout')).toBe('tests/tess-cafe-checkout');
    expect(workBranchPrefix('Tess.Dev')).toBe('tests/tess.dev-');
  });

  it('limits the slug to 40 characters', () => {
    expect(workBranchName('tess', `${'a'.repeat(30)} ${'b'.repeat(30)}`)).toBe(`tests/tess-${'a'.repeat(30)}-${'b'.repeat(9)}`);
  });

  it('rejects work names without letters or digits and invalid branch names', () => {
    expect(() => workBranchName('tess', 'تحسينات')).toThrow('The work name must contain letters or digits');
    expect(BRANCH_NAME_RE.test('tests/tess-login-fixes')).toBe(true);
    expect(BRANCH_NAME_RE.test('main')).toBe(true);
    expect(BRANCH_NAME_RE.test('bad branch')).toBe(false);
    expect(BRANCH_NAME_RE.test('a..b')).toBe(false);
    expect(BRANCH_NAME_RE.test('/abs')).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest paths`
Expected: FAIL with "Cannot find module './paths'".

- [ ] **Step 3: Implement the path rules**

`src/modules/automation/paths.ts`:
```ts
import { BadRequestException } from '@nestjs/common';

/** Branch names accepted from clients: GitLab refs without spaces, "..", "//" or a leading "/". */
export const BRANCH_NAME_RE = /^(?!\/)(?!.*\/\/)(?!.*\.\.)[A-Za-z0-9._\-/]{1,200}$/;

/** Every branch the tool commits to starts with this prefix, so it can never be the default branch. */
export const WORK_BRANCH_PREFIX = 'tests/';

/** Repository-relative path with "/" separators, no surrounding or doubled slashes, no "." / ".." segments. */
export function normalizeRepoPath(raw: string): string {
  const path = raw.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  if (!path) throw new BadRequestException('Path is required');
  if (/[\x00-\x1f]/.test(path)) throw new BadRequestException('Path contains invalid characters');
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new BadRequestException('Path must not contain "." or ".." segments');
  }
  return path;
}

/** The normalized path, which must be the tests folder or inside it. */
export function resolveInTestsPath(testsPath: string, raw: string): string {
  const path = normalizeRepoPath(raw);
  if (path !== testsPath && !path.startsWith(`${testsPath}/`)) {
    throw new BadRequestException(`Path must be inside the tests folder "${testsPath}"`);
  }
  return path;
}

/** A writable file: inside the tests folder and ending in .ts or .js (covers .spec.ts / .test.ts). */
export function resolveEditablePath(testsPath: string, raw: string): string {
  const path = resolveInTestsPath(testsPath, raw);
  if (!/\.(ts|js)$/.test(path)) {
    throw new BadRequestException('Only .ts and .js files can be edited (for example login.spec.ts)');
  }
  return path;
}

export function workBranchPrefix(gitlabUsername: string): string {
  return `${WORK_BRANCH_PREFIX}${gitlabUsername.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}-`;
}

/** tests/<gitlab-username>-<slug>, the slug made from the short work name the user types on first save. */
export function workBranchName(gitlabUsername: string, workName: string): string {
  const slug = workName
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  if (!slug) throw new BadRequestException('The work name must contain letters or digits');
  return `${workBranchPrefix(gitlabUsername)}${slug}`;
}
```

Run: `npx jest paths`
Expected: 8 tests pass.

- [ ] **Step 4: Write the failing e2e tests**

`test/repository.e2e-spec.ts`:
```ts
import { FakeGitlab } from './utils/fake-gitlab';
import { seedActors, seedProject } from './utils/factories';
import { createGitlabTestApp, SAMPLE_FILES, seedGitlabConnection } from './utils/gitlab';
import { resetDb, TestContext } from './utils/test-app';

describe('Repository link (e2e)', () => {
  let ctx: TestContext;
  let fake: FakeGitlab;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let projectId: string;

  beforeAll(async () => {
    ({ ctx, fake } = await createGitlabTestApp());
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    fake.reset();
    actors = await seedActors(ctx);
    const { gitlabUser } = await seedGitlabConnection(ctx, fake, actors.admin.id, { username: 'admin' });
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

  it('lets only admins link or unlink', async () => {
    await ctx.http().put(url()).set(actors.testerAuth).send({ gitlabProjectId: 101, testsPath: 'e2e' }).expect(403);
    await ctx.http().delete(url()).set(actors.testerAuth).expect(403);
  });

  it("returns GitLab's 404 for projects the admin cannot access", async () => {
    const res = await link({ gitlabProjectId: 999, testsPath: 'e2e' }).expect(404);
    expect(res.body).toEqual({ statusCode: 404, error: 'Not Found', message: '404 Project Not Found', details: { source: 'gitlab' } });
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
```

In `test/gitlab-disabled.e2e-spec.ts`, change the factories import to `import { seedActors, seedProject } from './utils/factories';` and add this test at the end of the `describe`:
```ts
  it('hides the repository link endpoints', async () => {
    const project = await seedProject(ctx.prisma, actors.admin.id);
    await expectHidden('put', `/api/projects/${project.id}/repository`, { gitlabProjectId: 101, testsPath: 'e2e' });
    await expectHidden('delete', `/api/projects/${project.id}/repository`);
  });
```

- [ ] **Step 5: Run them to verify they fail**

Run: `npm run test:e2e -- repository gitlab-disabled`
Expected: FAIL. `PUT /api/projects/:id/repository` answers 404 "Cannot PUT …" instead of 200, and in the disabled file the message is "Cannot PUT …" instead of "GitLab integration is not configured".

- [ ] **Step 6: Implement the DTO, service, controller and module**

`src/modules/automation/dto/link-repository.dto.ts`:
```ts
import { IsInt, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../../common/decorators/is-optional-non-null.decorator';
import { BRANCH_NAME_RE } from '../paths';

export class LinkRepositoryDto {
  /** GitLab project id (from GET /api/gitlab/projects). */
  @IsInt()
  @Min(1)
  gitlabProjectId!: number;

  /** Defaults to the GitLab project's default branch. */
  @IsOptionalNonNull()
  @IsString()
  @Matches(BRANCH_NAME_RE, { message: 'defaultBranch is not a valid branch name' })
  defaultBranch?: string;

  /** Folder with the Playwright tests, e.g. e2e. */
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  testsPath!: string;

  /** Defaults to playwright.config.ts. */
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  playwrightConfigPath?: string;
}
```

`src/modules/automation/repository.service.ts`:
```ts
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { GitlabApiService } from '../gitlab/gitlab-api.service';
import { GitlabConnectionService } from '../gitlab/gitlab-connection.service';
import { ProjectsService } from '../projects/projects.service';
import { LinkRepositoryDto } from './dto/link-repository.dto';
import { normalizeRepoPath } from './paths';

export const REPOSITORY_SELECT = {
  id: true,
  gitlabProjectId: true,
  gitlabPath: true,
  gitlabWebUrl: true,
  defaultBranch: true,
  testsPath: true,
  playwrightConfigPath: true,
} satisfies Prisma.ProjectSelect;

@Injectable()
export class RepositoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly gitlab: GitlabConnectionService,
    private readonly api: GitlabApiService,
  ) {}

  /** Links a GitLab project the admin can access (checked with the admin's own token). */
  async link(projectId: string, dto: LinkRepositoryDto, user: AuthUser) {
    await this.projects.requireProject(projectId);
    const testsPath = normalizeRepoPath(dto.testsPath);
    const playwrightConfigPath = normalizeRepoPath(dto.playwrightConfigPath ?? 'playwright.config.ts');

    const repo = await this.gitlab.withToken(user.id, async (token) => {
      const project = await this.api.getProject(token, dto.gitlabProjectId);
      const defaultBranch = dto.defaultBranch ?? project.defaultBranch;
      if (!defaultBranch) {
        throw new BadRequestException(`${project.pathWithNamespace} has no default branch yet – push a first commit`);
      }
      if (dto.defaultBranch && !(await this.api.getBranch(token, project.id, dto.defaultBranch))) {
        throw new BadRequestException(`Branch "${dto.defaultBranch}" does not exist in ${project.pathWithNamespace}`);
      }
      return { project, defaultBranch };
    });

    return this.prisma.project.update({
      where: { id: projectId },
      data: {
        gitlabProjectId: repo.project.id,
        gitlabPath: repo.project.pathWithNamespace,
        gitlabWebUrl: repo.project.webUrl,
        defaultBranch: repo.defaultBranch,
        testsPath,
        playwrightConfigPath,
      },
      select: REPOSITORY_SELECT,
    });
  }

  /** Clears the link; runs keep their branch/pipeline history. */
  async unlink(projectId: string): Promise<void> {
    await this.projects.requireProject(projectId);
    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        gitlabProjectId: null,
        gitlabPath: null,
        gitlabWebUrl: null,
        defaultBranch: null,
        testsPath: null,
        playwrightConfigPath: null,
      },
      select: { id: true },
    });
  }
}
```

`src/modules/automation/repository.controller.ts`:
```ts
import { Body, Controller, Delete, HttpCode, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { GitlabEnabledGuard } from '../gitlab/gitlab-enabled.guard';
import { LinkRepositoryDto } from './dto/link-repository.dto';
import { RepositoryService } from './repository.service';

@ApiTags('Automation')
@ApiBearerAuth()
@UseGuards(GitlabEnabledGuard)
@Roles(Role.ADMIN)
@Controller('projects/:projectId/repository')
export class RepositoryController {
  constructor(private readonly repository: RepositoryService) {}

  @Put()
  link(@Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: LinkRepositoryDto, @CurrentUser() user: AuthUser) {
    return this.repository.link(projectId, dto, user);
  }

  @Delete()
  @HttpCode(204)
  unlink(@Param('projectId', ParseUUIDPipe) projectId: string): Promise<void> {
    return this.repository.unlink(projectId);
  }
}
```

`src/modules/automation/automation.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { GitlabModule } from '../gitlab/gitlab.module';
import { ProjectsModule } from '../projects/projects.module';
import { RepositoryController } from './repository.controller';
import { RepositoryService } from './repository.service';

@Module({
  imports: [GitlabModule, ProjectsModule],
  controllers: [RepositoryController],
  providers: [RepositoryService],
})
export class AutomationModule {}
```

In `src/app.module.ts`, import `AutomationModule` from `./modules/automation/automation.module` and add it to `imports` after `GitlabModule`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run test:e2e -- repository gitlab-disabled && npm run typecheck && npm test && npm run test:e2e`
Expected: `repository` 5 and `gitlab-disabled` 3 tests pass. Then unit `Tests: 79 passed`, and e2e `Tests: 93 passed, 93 total`, with no warnings.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: link projects to GitLab repositories with path rules

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Tests folder tree, file read and save → work branch + merge request

**Files:**
- Create: `src/modules/automation/case-tags.ts`, `src/modules/automation/mr-description.ts`, `src/modules/automation/dto/automation-query.dto.ts`, `src/modules/automation/dto/save-file.dto.ts`, `src/modules/automation/automation.service.ts`, `src/modules/automation/automation.controller.ts`
- Modify: `src/modules/automation/automation.module.ts`, `src/app.setup.ts` (JSON body limit), `test/gitlab-disabled.e2e-spec.ts` (one more test)
- Test: `src/modules/automation/case-tags.spec.ts`, `src/modules/automation/mr-description.spec.ts`, `test/automation-files.e2e-spec.ts`

**Interfaces:**
- Consumes: `paths.ts` (Task 4); `GitlabConnectionService.requireConnection/withToken`, `GitlabApiService`, `GitlabHttpError`, `GitlabEnabledGuard` (Tasks 2–3); `ProjectsService.requireProject`; test helpers `seedLinkedProject`, `LOGIN_SPEC`, `GITLAB_PROJECT_ID` (Task 3).
- Produces:
  - `CASE_TAG_RE`, `extractCaseTags(text: string): string[]` (unique, sorted codes without the `@`, e.g. `TC-AUTH-001`).
  - `buildMrDescription(previous: string | null, file: string, caseCodes: string[]): string`, `mergeRequestTitle(workName: string): string` (`Tests: <work name>`).
  - `LinkedProject = Project & { gitlabProjectId: number; gitlabPath: string; gitlabWebUrl: string; defaultBranch: string; testsPath: string; playwrightConfigPath: string }`. `AutomationService.requireLinked(projectId): Promise<LinkedProject>` (409 `Project is not linked to a GitLab repository`), plus `branches`, `tree`, `readFile`, `saveFile`. `MAX_EDITABLE_BYTES = 1048576`. `STALE_FILE_MESSAGE`.
  - `RefQueryDto { ref? }`, `FileQueryDto { ref?, path }`, `SaveFileDto { path, content, lastCommitId?, branchSlug }`.
  - `GET /api/projects/:projectId/automation/branches` → `{ defaultBranch, branches: { name, isDefault, mergeRequest: { iid, webUrl, state } | null }[] }` (the default branch plus the caller's `tests/<username>-*` branches).
  - `GET …/automation/tree?ref=` → `{ ref, testsPath, entries: { path, name, type }[] }`.
  - `GET …/automation/file?ref=&path=` → `{ path, ref, content, lastCommitId, size, readOnly }`.
  - `PUT …/automation/file` with `{ path, content, lastCommitId?, branchSlug }` → `{ branch, commitId, mergeRequest: { iid, webUrl, state } }`. Errors: 400 path rules; 409 `This file changed on the branch – reload it before saving`; 409 `A file with this path already exists – open it before saving`; 413 `Files larger than 1 MB are read-only`.
  - `AutomationModule` now exports `AutomationService`.

- [ ] **Step 1: Write the failing unit tests**

`src/modules/automation/case-tags.spec.ts`:
```ts
import { extractCaseTags } from './case-tags';

describe('extractCaseTags', () => {
  it('finds tags in titles and tag options, unique and sorted', () => {
    const source = [
      "test('rejects a wrong password @TC-AUTH-002', async () => {});",
      "test('logs in', { tag: ['@TC-AUTH-001', '@smoke'] }, async () => {});",
      '// covered again: @TC-AUTH-002',
    ].join('\n');
    expect(extractCaseTags(source)).toEqual(['TC-AUTH-001', 'TC-AUTH-002']);
  });

  it('ignores text that only looks like a tag', () => {
    expect(extractCaseTags('TC-AUTH-001 @tc-auth-001 @TC-AUTH-abc @TC-AUTH-001x')).toEqual([]);
  });
});
```

`src/modules/automation/mr-description.spec.ts`:
```ts
import { buildMrDescription, mergeRequestTitle } from './mr-description';

describe('merge request description', () => {
  it('lists the edited file and the linked cases', () => {
    expect(buildMrDescription(null, 'e2e/a.spec.ts', ['TC-AUTH-001'])).toBe(
      [
        'Test changes made in the Ejad test case tool.',
        '',
        '**Edited files**',
        '- `e2e/a.spec.ts`',
        '',
        '**Linked test cases**',
        '- TC-AUTH-001',
      ].join('\n'),
    );
  });

  it('merges with the previous description without duplicates', () => {
    const previous = buildMrDescription(null, 'e2e/b.spec.ts', ['TC-CART-001']);
    const next = buildMrDescription(previous, 'e2e/a.spec.ts', ['TC-AUTH-001', 'TC-CART-001']);
    expect(next).toContain('**Edited files**\n- `e2e/a.spec.ts`\n- `e2e/b.spec.ts`\n\n');
    expect(next.endsWith('**Linked test cases**\n- TC-AUTH-001\n- TC-CART-001')).toBe(true);
  });

  it('ignores hand-written descriptions and shows "none" without cases', () => {
    const next = buildMrDescription('Hand-written text\n- `not/a/list.ts`', 'e2e/a.spec.ts', []);
    expect(next).toContain('**Edited files**\n- `e2e/a.spec.ts`\n\n');
    expect(next.endsWith('**Linked test cases**\n- none')).toBe(true);
    expect(mergeRequestTitle('  Login fixes ')).toBe('Tests: Login fixes');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest case-tags mr-description`
Expected: FAIL with "Cannot find module './case-tags'" and "Cannot find module './mr-description'".

- [ ] **Step 3: Implement tag extraction and the MR description**

`src/modules/automation/case-tags.ts`:
```ts
/** A test case tag in a Playwright title or `tag` option, e.g. @TC-AUTH-001. */
export const CASE_TAG_RE = /@(TC-[A-Z0-9]+-\d+)(?![A-Za-z0-9])/g;

/** Unique case codes (without "@"), sorted. */
export function extractCaseTags(text: string): string[] {
  return [...new Set([...text.matchAll(CASE_TAG_RE)].map((m) => m[1]))].sort();
}
```

`src/modules/automation/mr-description.ts`:
```ts
const INTRO = 'Test changes made in the Ejad test case tool.';
const FILES_HEADER = '**Edited files**';
const CASES_HEADER = '**Linked test cases**';

/** Items of a "- item" list directly under `header` in a description this module wrote. */
function readList(description: string | null, header: string): string[] {
  if (!description) return [];
  const lines = description.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = line.trim().match(/^- `?([^`]+?)`?$/);
    if (!match) break;
    if (match[1] !== 'none') items.push(match[1]);
  }
  return items;
}

/** Description for the work-branch MR: all files edited so far and all case codes they tag. */
export function buildMrDescription(previous: string | null, file: string, caseCodes: string[]): string {
  const files = [...new Set([...readList(previous, FILES_HEADER), file])].sort();
  const cases = [...new Set([...readList(previous, CASES_HEADER), ...caseCodes])].sort();
  return [
    INTRO,
    '',
    FILES_HEADER,
    ...files.map((f) => `- \`${f}\``),
    '',
    CASES_HEADER,
    ...(cases.length ? cases.map((c) => `- ${c}`) : ['- none']),
  ].join('\n');
}

export function mergeRequestTitle(workName: string): string {
  return `Tests: ${workName.trim()}`.slice(0, 255);
}
```

Run: `npx jest case-tags mr-description`
Expected: 5 tests pass.

- [ ] **Step 4: Write the failing e2e tests**

`test/automation-files.e2e-spec.ts`:
```ts
import { FakeGitlab } from './utils/fake-gitlab';
import { seedActors } from './utils/factories';
import { createGitlabTestApp, GITLAB_PROJECT_ID as P, LOGIN_SPEC, seedGitlabConnection, seedLinkedProject } from './utils/gitlab';
import { resetDb, TestContext } from './utils/test-app';

const LOGIN = 'e2e/auth/login.spec.ts';
const WORK_BRANCH = 'tests/tess-login-fixes';

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

  it('requires a linked repository', async () => {
    await ctx.prisma.project.update({ where: { id: projectId }, data: { gitlabProjectId: null } });
    const res = await ctx.http().get(`${base()}/tree`).set(actors.testerAuth).expect(409);
    expect(res.body.message).toBe('Project is not linked to a GitLab repository');
  });
});
```

Add this test at the end of the `describe` in `test/gitlab-disabled.e2e-spec.ts`:
```ts
  it('hides the automation file endpoints', async () => {
    const project = await seedProject(ctx.prisma, actors.admin.id, { key: 'AUTO' });
    const base = `/api/projects/${project.id}/automation`;
    await expectHidden('get', `${base}/branches`);
    await expectHidden('get', `${base}/tree`);
    await expectHidden('get', `${base}/file?path=e2e/a.spec.ts`);
    await expectHidden('put', `${base}/file`, { path: 'e2e/a.spec.ts', content: 'x', branchSlug: 'x' });
  });
```

- [ ] **Step 5: Run them to verify they fail**

Run: `npm run test:e2e -- automation-files gitlab-disabled`
Expected: FAIL. The automation routes answer 404 "Cannot GET /api/projects/…/automation/tree".

- [ ] **Step 6: Implement DTOs, service, controller and module; raise the JSON body limit**

`src/modules/automation/dto/automation-query.dto.ts`:
```ts
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { BRANCH_NAME_RE } from '../paths';

export class RefQueryDto {
  /** Branch to read; defaults to the project's default branch. */
  @IsOptional()
  @IsString()
  @Matches(BRANCH_NAME_RE, { message: 'ref is not a valid branch name' })
  ref?: string;
}

export class FileQueryDto extends RefQueryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  path!: string;
}
```

`src/modules/automation/dto/save-file.dto.ts`:
```ts
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../../common/decorators/is-optional-non-null.decorator';

export class SaveFileDto {
  /** Repository path inside the project's tests folder. */
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  path!: string;

  @IsString()
  content!: string;

  /** last_commit_id from GET …/automation/file; omit only when creating a new file. */
  @IsOptionalNonNull()
  @IsString()
  @Matches(/^[0-9a-f]{7,64}$/, { message: 'lastCommitId must be a commit SHA' })
  lastCommitId?: string;

  /** Short work name, e.g. "login fixes" → branch tests/<gitlab-username>-login-fixes. */
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  branchSlug!: string;
}
```

`src/modules/automation/automation.service.ts`:
```ts
import { BadRequestException, ConflictException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { Project } from '@prisma/client';
import { AuthUser } from '../../common/types/auth-user';
import { GitlabApiService } from '../gitlab/gitlab-api.service';
import { GitlabConnectionService } from '../gitlab/gitlab-connection.service';
import { GitlabHttpError } from '../gitlab/gitlab-http-error';
import { GitlabCommit, GitlabMergeRequest } from '../gitlab/gitlab.types';
import { ProjectsService } from '../projects/projects.service';
import { extractCaseTags } from './case-tags';
import { FileQueryDto } from './dto/automation-query.dto';
import { SaveFileDto } from './dto/save-file.dto';
import { buildMrDescription, mergeRequestTitle } from './mr-description';
import { resolveEditablePath, resolveInTestsPath, workBranchName, workBranchPrefix } from './paths';

export const MAX_EDITABLE_BYTES = 1024 * 1024;
export const STALE_FILE_MESSAGE = 'This file changed on the branch – reload it before saving';

export type LinkedProject = Project & {
  gitlabProjectId: number;
  gitlabPath: string;
  gitlabWebUrl: string;
  defaultBranch: string;
  testsPath: string;
  playwrightConfigPath: string;
};

export interface MergeRequestRef {
  iid: number;
  webUrl: string;
  state: GitlabMergeRequest['state'];
}

const toRef = (mr: GitlabMergeRequest): MergeRequestRef => ({ iid: mr.iid, webUrl: mr.webUrl, state: mr.state });

@Injectable()
export class AutomationService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly gitlab: GitlabConnectionService,
    private readonly api: GitlabApiService,
  ) {}

  async requireLinked(projectId: string): Promise<LinkedProject> {
    const project = await this.projects.requireProject(projectId);
    const { gitlabProjectId, gitlabPath, gitlabWebUrl, defaultBranch, testsPath } = project;
    if (gitlabProjectId === null || !gitlabPath || !gitlabWebUrl || !defaultBranch || !testsPath) {
      throw new ConflictException('Project is not linked to a GitLab repository');
    }
    return {
      ...project,
      gitlabProjectId,
      gitlabPath,
      gitlabWebUrl,
      defaultBranch,
      testsPath,
      playwrightConfigPath: project.playwrightConfigPath ?? 'playwright.config.ts',
    };
  }

  /** The default branch plus the caller's own work branches, each with its latest merge request. */
  async branches(projectId: string, user: AuthUser) {
    const project = await this.requireLinked(projectId);
    const connection = await this.gitlab.requireConnection(user.id);
    const prefix = workBranchPrefix(connection.username);
    return this.gitlab.withToken(user.id, async (token) => {
      const work = (await this.api.listBranches(token, project.gitlabProjectId, prefix))
        .filter((b) => b.name.startsWith(prefix))
        .sort((a, b) => a.name.localeCompare(b.name));
      const branches: { name: string; isDefault: boolean; mergeRequest: MergeRequestRef | null }[] = [
        { name: project.defaultBranch, isDefault: true, mergeRequest: null },
      ];
      for (const b of work) {
        const [mr] = await this.api.listMergeRequests(token, project.gitlabProjectId, { sourceBranch: b.name, state: 'all' });
        branches.push({ name: b.name, isDefault: false, mergeRequest: mr ? toRef(mr) : null });
      }
      return { defaultBranch: project.defaultBranch, branches };
    });
  }

  async tree(projectId: string, ref: string | undefined, user: AuthUser) {
    const project = await this.requireLinked(projectId);
    const branch = ref ?? project.defaultBranch;
    const entries = await this.gitlab.withToken(user.id, (token) => this.api.listTree(token, project.gitlabProjectId, branch, project.testsPath));
    return { ref: branch, testsPath: project.testsPath, entries };
  }

  async readFile(projectId: string, query: FileQueryDto, user: AuthUser) {
    const project = await this.requireLinked(projectId);
    const path = resolveInTestsPath(project.testsPath, query.path);
    const ref = query.ref ?? project.defaultBranch;
    const file = await this.gitlab.withToken(user.id, (token) => this.api.getFile(token, project.gitlabProjectId, ref, path));
    if (!file) throw new NotFoundException(`File "${path}" was not found on ${ref}`);
    return {
      path,
      ref,
      content: file.content,
      lastCommitId: file.lastCommitId,
      size: file.size,
      readOnly: file.size > MAX_EDITABLE_BYTES || !/\.(ts|js)$/.test(path),
    };
  }

  /**
   * Commits one file to the caller's work branch (created from the default branch on first save)
   * and opens or updates that branch's merge request. Never commits to the default branch.
   */
  async saveFile(projectId: string, dto: SaveFileDto, user: AuthUser) {
    const project = await this.requireLinked(projectId);
    const path = resolveEditablePath(project.testsPath, dto.path);
    if (Buffer.byteLength(dto.content, 'utf8') > MAX_EDITABLE_BYTES) {
      throw new PayloadTooLargeException('Files larger than 1 MB are read-only');
    }
    const connection = await this.gitlab.requireConnection(user.id);
    const branch = workBranchName(connection.username, dto.branchSlug);
    if (branch === project.defaultBranch) throw new BadRequestException('The tool never commits to the default branch');
    const pid = project.gitlabProjectId;

    return this.gitlab.withToken(user.id, async (token) => {
      const branchExists = (await this.api.getBranch(token, pid, branch)) !== null;
      const current = await this.api.getFile(token, pid, branchExists ? branch : project.defaultBranch, path);
      if (current && !dto.lastCommitId) {
        throw new ConflictException('A file with this path already exists – open it before saving');
      }
      if ((current && dto.lastCommitId !== current.lastCommitId) || (!current && dto.lastCommitId)) {
        throw new ConflictException(STALE_FILE_MESSAGE);
      }

      let commit: GitlabCommit;
      try {
        commit = await this.api.createCommit(token, pid, {
          branch,
          startBranch: branchExists ? undefined : project.defaultBranch,
          message: `${current ? 'Update' : 'Add'} ${path} (Ejad test cases)`,
          actions: [{ action: current ? 'update' : 'create', filePath: path, content: dto.content, lastCommitId: current?.lastCommitId }],
        });
      } catch (e) {
        // A push between our check and the commit: GitLab rejects the stale last_commit_id.
        if (e instanceof GitlabHttpError && e.status === 400 && /changed since|already exists|doesn't exist/i.test(e.message)) {
          throw new ConflictException(STALE_FILE_MESSAGE);
        }
        throw e;
      }

      const codes = extractCaseTags(dto.content);
      const [open] = await this.api.listMergeRequests(token, pid, { sourceBranch: branch, state: 'opened' });
      const mr = open
        ? await this.api.updateMergeRequest(token, pid, open.iid, { description: buildMrDescription(open.description, path, codes) })
        : await this.api.createMergeRequest(token, pid, {
            sourceBranch: branch,
            targetBranch: project.defaultBranch,
            title: mergeRequestTitle(dto.branchSlug),
            description: buildMrDescription(null, path, codes),
          });
      return { branch, commitId: commit.id, mergeRequest: toRef(mr) };
    });
  }
}
```

`src/modules/automation/automation.controller.ts`:
```ts
import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { GitlabEnabledGuard } from '../gitlab/gitlab-enabled.guard';
import { AutomationService } from './automation.service';
import { FileQueryDto, RefQueryDto } from './dto/automation-query.dto';
import { SaveFileDto } from './dto/save-file.dto';

@ApiTags('Automation')
@ApiBearerAuth()
@UseGuards(GitlabEnabledGuard)
@Controller('projects/:projectId/automation')
export class AutomationController {
  constructor(private readonly automation: AutomationService) {}

  @Get('branches')
  branches(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: AuthUser) {
    return this.automation.branches(projectId, user);
  }

  @Get('tree')
  tree(@Param('projectId', ParseUUIDPipe) projectId: string, @Query() query: RefQueryDto, @CurrentUser() user: AuthUser) {
    return this.automation.tree(projectId, query.ref, user);
  }

  @Get('file')
  readFile(@Param('projectId', ParseUUIDPipe) projectId: string, @Query() query: FileQueryDto, @CurrentUser() user: AuthUser) {
    return this.automation.readFile(projectId, query, user);
  }

  @Put('file')
  saveFile(@Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: SaveFileDto, @CurrentUser() user: AuthUser) {
    return this.automation.saveFile(projectId, dto, user);
  }
}
```

Replace `src/modules/automation/automation.module.ts` with:
```ts
import { Module } from '@nestjs/common';
import { GitlabModule } from '../gitlab/gitlab.module';
import { ProjectsModule } from '../projects/projects.module';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';
import { RepositoryController } from './repository.controller';
import { RepositoryService } from './repository.service';

@Module({
  imports: [GitlabModule, ProjectsModule],
  controllers: [RepositoryController, AutomationController],
  providers: [RepositoryService, AutomationService],
  exports: [AutomationService],
})
export class AutomationModule {}
```

Replace `src/app.setup.ts` with the version below. Express's default JSON limit is 100 kb, and the editor saves files up to 1 MB. The parser registered here comes first, so Nest skips its default `jsonParser`:
```ts
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);
  const trustProxy = config.get<boolean | number | string>('trustProxy');
  // Behind a reverse proxy (Dokploy/Traefik) req.ip must come from X-Forwarded-For,
  // otherwise every user shares the proxy's IP and one login rate-limit bucket.
  if (trustProxy !== undefined) app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);
  // Test files up to 1 MB are saved from the web editor as JSON (default limit is 100 kb).
  (app as NestExpressApplication).useBodyParser('json', { limit: '2mb' });
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.enableCors({ origin: config.get<string[]>('corsOrigins'), credentials: true, exposedHeaders: ['Content-Disposition'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run test:e2e -- automation-files gitlab-disabled && npm run typecheck && npm test && npm run test:e2e`
Expected: `automation-files` 9 and `gitlab-disabled` 4 tests pass. Then unit `Tests: 84 passed`, and e2e `Tests: 103 passed, 103 total`, with no warnings.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: automation tree, file read and save to work branch with merge request

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Coverage by `@TC` tags, cached per commit SHA

**Files:**
- Create: `src/modules/automation/coverage.ts`, `src/modules/automation/coverage-cache.ts`, `src/modules/automation/coverage.service.ts`, `src/modules/automation/coverage.controller.ts`
- Modify: `src/modules/automation/automation.module.ts`
- Test: `src/modules/automation/coverage.spec.ts`, `test/automation-coverage.e2e-spec.ts`

**Interfaces:**
- Consumes: `extractCaseTags` (Task 5), `AutomationService.requireLinked` (Task 5), `RefQueryDto` (Task 5), `GitlabApiService.getBranch/listTree/getFile`, `GitlabConnectionService.withToken`.
- Produces:
  - `FileTags { path; codes: string[] }`, `CoverageCase { id; code; name; module: { code; name } }`, `FileCoverage { path; cases: { id; code; name }[]; unknownCodes: string[] }`, `Coverage { files: FileCoverage[]; notAutomated: CoverageCase[] }`, `computeCoverage(files: FileTags[], cases: CoverageCase[]): Coverage`.
  - `CoverageCache { get(key): FileTags[] | undefined; set(key, value): void }` (in memory, up to 100 entries, least recently used evicted first). The key is `<gitlabProjectId>:<commitSha>:<testsPath>`.
  - `GET /api/projects/:projectId/automation/coverage?ref=` → `{ ref, commitId, files: FileCoverage[], notAutomated: CoverageCase[] }`. Returns 404 `Branch "<ref>" was not found`. At most 500 `.ts`/`.js` files are scanned.

- [ ] **Step 1: Write the failing unit test**

`src/modules/automation/coverage.spec.ts`:
```ts
import { computeCoverage, CoverageCase } from './coverage';

const CASES: CoverageCase[] = [
  { id: 'c1', code: 'TC-AUTH-001', name: 'Login', module: { code: 'AUTH', name: 'Authentication' } },
  { id: 'c2', code: 'TC-AUTH-002', name: 'Wrong password', module: { code: 'AUTH', name: 'Authentication' } },
  { id: 'c3', code: 'TC-CART-001', name: 'Add item', module: { code: 'CART', name: 'Cart' } },
];

describe('computeCoverage', () => {
  it('maps tags to cases per file and keeps unknown codes apart', () => {
    const result = computeCoverage([{ path: 'e2e/login.spec.ts', codes: ['TC-AUTH-001', 'TC-AUTH-999'] }], CASES);
    expect(result.files).toEqual([
      { path: 'e2e/login.spec.ts', cases: [{ id: 'c1', code: 'TC-AUTH-001', name: 'Login' }], unknownCodes: ['TC-AUTH-999'] },
    ]);
  });

  it('lists cases without any tag as not automated', () => {
    const result = computeCoverage(
      [
        { path: 'e2e/a.spec.ts', codes: ['TC-AUTH-001'] },
        { path: 'e2e/b.spec.ts', codes: ['TC-AUTH-001'] },
      ],
      CASES,
    );
    expect(result.notAutomated.map((c) => c.code)).toEqual(['TC-AUTH-002', 'TC-CART-001']);
    expect(result.notAutomated[1]).toEqual(CASES[2]);
  });

  it('sorts files by path and keeps files without tags', () => {
    const result = computeCoverage(
      [
        { path: 'e2e/z.spec.ts', codes: [] },
        { path: 'e2e/a.spec.ts', codes: ['TC-CART-001'] },
      ],
      CASES,
    );
    expect(result.files.map((f) => f.path)).toEqual(['e2e/a.spec.ts', 'e2e/z.spec.ts']);
    expect(result.files[1]).toEqual({ path: 'e2e/z.spec.ts', cases: [], unknownCodes: [] });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest coverage`
Expected: FAIL with "Cannot find module './coverage'".

- [ ] **Step 3: Implement coverage and the cache**

`src/modules/automation/coverage.ts`:
```ts
export interface FileTags {
  path: string;
  codes: string[];
}

export interface CoverageCase {
  id: string;
  code: string;
  name: string;
  module: { code: string; name: string };
}

export interface FileCoverage {
  path: string;
  cases: { id: string; code: string; name: string }[];
  unknownCodes: string[];
}

export interface Coverage {
  files: FileCoverage[];
  notAutomated: CoverageCase[];
}

/** Which active cases each test file covers, and which cases no file covers yet. */
export function computeCoverage(files: FileTags[], cases: CoverageCase[]): Coverage {
  const byCode = new Map(cases.map((c) => [c.code, c]));
  const covered = new Set<string>();
  const fileCoverage = [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => {
      const known = file.codes.filter((code) => byCode.has(code));
      known.forEach((code) => covered.add(code));
      return {
        path: file.path,
        cases: known.map((code) => {
          const testCase = byCode.get(code)!;
          return { id: testCase.id, code: testCase.code, name: testCase.name };
        }),
        unknownCodes: file.codes.filter((code) => !byCode.has(code)),
      };
    });
  return { files: fileCoverage, notAutomated: cases.filter((c) => !covered.has(c.code)) };
}
```

`src/modules/automation/coverage-cache.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { FileTags } from './coverage';

/**
 * Tag scans keyed by "<gitlabProjectId>:<commitSha>:<testsPath>". A commit's content never
 * changes, so entries never go stale; the least recently used entry is evicted beyond 100.
 */
@Injectable()
export class CoverageCache {
  private readonly maxEntries = 100;
  private readonly entries = new Map<string, FileTags[]>();

  get(key: string): FileTags[] | undefined {
    const value = this.entries.get(key);
    if (value) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: FileTags[]): void {
    this.entries.set(key, value);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}
```

Run: `npx jest coverage`
Expected: 3 tests pass.

- [ ] **Step 4: Write the failing e2e test**

`test/automation-coverage.e2e-spec.ts`:
```ts
import { FakeGitlab } from './utils/fake-gitlab';
import { seedActors, seedCase, seedModule } from './utils/factories';
import { CART_SPEC, createGitlabTestApp, GITLAB_PROJECT_ID as P, seedGitlabConnection, seedLinkedProject } from './utils/gitlab';
import { resetDb, TestContext } from './utils/test-app';

describe('Automation coverage (e2e)', () => {
  let ctx: TestContext;
  let fake: FakeGitlab;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let projectId: string;
  let ids: Record<string, string>;

  beforeAll(async () => {
    ({ ctx, fake } = await createGitlabTestApp());
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    fake.reset();
    actors = await seedActors(ctx);
    const { gitlabUser } = await seedGitlabConnection(ctx, fake, actors.tester.id, { username: 'tess' });
    projectId = (await seedLinkedProject(ctx, fake, actors.admin.id, [gitlabUser])).project.id;
    const auth = await seedModule(ctx.prisma, projectId, { code: 'AUTH' });
    const cart = await seedModule(ctx.prisma, projectId, { code: 'CART', name: 'Cart' });
    ids = {};
    for (const [moduleId, code] of [
      [auth.id, 'TC-AUTH-001'],
      [auth.id, 'TC-AUTH-002'],
      [auth.id, 'TC-AUTH-003'],
      [cart.id, 'TC-CART-001'],
      [cart.id, 'TC-CART-002'],
    ]) {
      ids[code] = (await seedCase(ctx.prisma, { projectId, moduleId, userId: actors.admin.id, code })).id;
    }
    await ctx.prisma.testCase.update({ where: { id: ids['TC-CART-002'] }, data: { deletedAt: new Date() } });
  });
  afterAll(async () => {
    await ctx.app.close();
    await fake.close();
  });

  const coverage = (query: Record<string, string> = {}) =>
    ctx.http().get(`/api/projects/${projectId}/automation/coverage`).query(query).set(actors.testerAuth);

  it('reports covered cases per file, unknown tags and cases not automated yet', async () => {
    const res = await coverage().expect(200);
    expect(res.body.ref).toBe('main');
    expect(res.body.commitId).toBe(fake.branch(P, 'main')!.commitId);
    expect(res.body.files).toEqual([
      {
        path: 'e2e/auth/login.spec.ts',
        cases: [
          { id: ids['TC-AUTH-001'], code: 'TC-AUTH-001', name: 'Case TC-AUTH-001' },
          { id: ids['TC-AUTH-002'], code: 'TC-AUTH-002', name: 'Case TC-AUTH-002' },
        ],
        unknownCodes: ['TC-AUTH-999'],
      },
      { path: 'e2e/cart/cart.spec.ts', cases: [], unknownCodes: [] },
      { path: 'e2e/fixtures/users.ts', cases: [], unknownCodes: [] },
    ]);
    expect(res.body.notAutomated.map((c: { code: string }) => c.code)).toEqual(['TC-AUTH-003', 'TC-CART-001']);
    expect(res.body.notAutomated[0]).toEqual({
      id: ids['TC-AUTH-003'],
      code: 'TC-AUTH-003',
      name: 'Case TC-AUTH-003',
      module: { code: 'AUTH', name: 'Authentication' },
    });
  });

  it('caches the scan per commit and rescans after a new commit', async () => {
    await coverage().expect(200);
    expect(fake.requestsTo('/repository/files/')).toHaveLength(3);
    await coverage().expect(200);
    expect(fake.requestsTo('/repository/files/')).toHaveLength(3);

    fake.setFile(P, 'main', 'e2e/cart/cart.spec.ts', CART_SPEC.replace('adds an item to the cart', 'adds an item to the cart @TC-CART-001'));
    const res = await coverage().expect(200);
    expect(fake.requestsTo('/repository/files/')).toHaveLength(6);
    expect(res.body.notAutomated.map((c: { code: string }) => c.code)).toEqual(['TC-AUTH-003']);
  });

  it('returns 404 for an unknown branch', async () => {
    const res = await coverage({ ref: 'nope' }).expect(404);
    expect(res.body.message).toBe('Branch "nope" was not found');
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npm run test:e2e -- automation-coverage`
Expected: FAIL (404 "Cannot GET …/automation/coverage").

- [ ] **Step 6: Implement the service, controller and module wiring**

`src/modules/automation/coverage.service.ts`:
```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { GitlabApiService } from '../gitlab/gitlab-api.service';
import { GitlabConnectionService } from '../gitlab/gitlab-connection.service';
import { AutomationService } from './automation.service';
import { extractCaseTags } from './case-tags';
import { computeCoverage, FileTags } from './coverage';
import { CoverageCache } from './coverage-cache';

const MAX_SCANNED_FILES = 500;

@Injectable()
export class CoverageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly automation: AutomationService,
    private readonly gitlab: GitlabConnectionService,
    private readonly api: GitlabApiService,
    private readonly cache: CoverageCache,
  ) {}

  async coverage(projectId: string, ref: string | undefined, user: AuthUser) {
    const project = await this.automation.requireLinked(projectId);
    const branchName = ref ?? project.defaultBranch;
    const pid = project.gitlabProjectId;

    const { commitId, files } = await this.gitlab.withToken(user.id, async (token) => {
      const branch = await this.api.getBranch(token, pid, branchName);
      if (!branch) throw new NotFoundException(`Branch "${branchName}" was not found`);
      const key = `${pid}:${branch.commitId}:${project.testsPath}`;
      const cached = this.cache.get(key);
      if (cached) return { commitId: branch.commitId, files: cached };

      // Read by commit SHA so the whole scan sees one consistent snapshot.
      const blobs = (await this.api.listTree(token, pid, branch.commitId, project.testsPath))
        .filter((entry) => entry.type === 'blob' && /\.(ts|js)$/.test(entry.path))
        .slice(0, MAX_SCANNED_FILES);
      const scanned: FileTags[] = [];
      for (const blob of blobs) {
        const file = await this.api.getFile(token, pid, branch.commitId, blob.path);
        scanned.push({ path: blob.path, codes: file ? extractCaseTags(file.content) : [] });
      }
      this.cache.set(key, scanned);
      return { commitId: branch.commitId, files: scanned };
    });

    const cases = await this.prisma.testCase.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true, module: { select: { code: true, name: true } } },
    });
    return { ref: branchName, commitId, ...computeCoverage(files, cases) };
  }
}
```

`src/modules/automation/coverage.controller.ts`:
```ts
import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { GitlabEnabledGuard } from '../gitlab/gitlab-enabled.guard';
import { CoverageService } from './coverage.service';
import { RefQueryDto } from './dto/automation-query.dto';

@ApiTags('Automation')
@ApiBearerAuth()
@UseGuards(GitlabEnabledGuard)
@Controller('projects/:projectId/automation')
export class CoverageController {
  constructor(private readonly coverage: CoverageService) {}

  @Get('coverage')
  get(@Param('projectId', ParseUUIDPipe) projectId: string, @Query() query: RefQueryDto, @CurrentUser() user: AuthUser) {
    return this.coverage.coverage(projectId, query.ref, user);
  }
}
```

Replace `src/modules/automation/automation.module.ts` with:
```ts
import { Module } from '@nestjs/common';
import { GitlabModule } from '../gitlab/gitlab.module';
import { ProjectsModule } from '../projects/projects.module';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';
import { CoverageCache } from './coverage-cache';
import { CoverageController } from './coverage.controller';
import { CoverageService } from './coverage.service';
import { RepositoryController } from './repository.controller';
import { RepositoryService } from './repository.service';

@Module({
  imports: [GitlabModule, ProjectsModule],
  controllers: [RepositoryController, AutomationController, CoverageController],
  providers: [RepositoryService, AutomationService, CoverageService, CoverageCache],
  exports: [AutomationService],
})
export class AutomationModule {}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run test:e2e -- automation-coverage && npm run typecheck && npm test && npm run test:e2e`
Expected: 3 coverage e2e tests pass. Then unit `Tests: 87 passed`, and e2e `Tests: 106 passed, 106 total`, with no warnings.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: automation coverage from @TC tags cached per commit

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Trigger automated runs in GitLab CI

**Files:**
- Create: `src/modules/automated-runs/run-scope.ts`, `src/modules/automated-runs/dto/create-automated-run.dto.ts`, `src/modules/automated-runs/automated-runs.service.ts`, `src/modules/automated-runs/automated-runs.controller.ts`, `src/modules/automated-runs/automated-runs.module.ts`
- Modify: `src/modules/runs/runs.module.ts` (export `RunsService`), `src/modules/runs/runs.service.ts` (`findOne` includes `triggeredBy`), `src/app.module.ts` (import `AutomatedRunsModule`), `test/gitlab-disabled.e2e-spec.ts` (one more test)
- Test: `src/modules/automated-runs/run-scope.spec.ts`, `test/automated-runs.e2e-spec.ts`

**Interfaces:**
- Consumes: `AutomationService.requireLinked`, `LinkedProject` (Task 5); `resolveInTestsPath`, `BRANCH_NAME_RE` (Task 4); `GitlabConnectionService.accessToken/markNeedsReconnect`, `GitlabApiService.createPipeline`, `GitlabHttpError` (Tasks 2–3); `RunsService.findOne`.
- Produces:
  - `PipelineScope { path?: string; codes?: string[] }`, `pipelineVariables(runId: string, scope: PipelineScope): Record<string, string>` (`EJAD_RUN_ID`; `EJAD_TEST_PATH` when there is a path; `EJAD_TEST_GREP` = `@TC-A-001\b|@TC-B-002\b` when there are codes). `automatedRunName(branch: string, at: Date): string` (`Automated · <branch> · YYYY-MM-DD HH:MM UTC`).
  - `AUTOMATED_SCOPE_MODES = ['ALL', 'PATH', 'CASES']`, `AutomatedScopeDto { mode; path?; caseIds? }`, `CreateAutomatedRunDto { branch; name?; scope }`.
  - `POST /api/projects/:projectId/runs/automated` → 201 run detail (the same shape as `GET /api/runs/:id`). The run has `type AUTOMATED`, `status IN_PROGRESS`, `branch`, `triggeredById`, `pipelineId`, `pipelineWebUrl`, `pipelineStatus`. CASES scope pre-creates NOT_EXECUTED results. When GitLab refuses the pipeline, the run comes back `COMPLETED` with `note = "GitLab could not start the pipeline: <GitLab message>"`. No GitLab connection → 403 and no run.
  - `GET /api/runs/:id` now also returns `triggeredBy: { id, name } | null`. `RunsModule` exports `RunsService`.
  - `AutomatedRunsModule` (imports `GitlabModule`, `AutomationModule`, `RunsModule`).

- [ ] **Step 1: Write the failing unit test**

`src/modules/automated-runs/run-scope.spec.ts`:
```ts
import { automatedRunName, pipelineVariables } from './run-scope';

describe('pipeline scope', () => {
  it('builds the CI variables for each scope', () => {
    expect(pipelineVariables('r1', {})).toEqual({ EJAD_RUN_ID: 'r1' });
    expect(pipelineVariables('r1', { path: 'e2e/auth' })).toEqual({ EJAD_RUN_ID: 'r1', EJAD_TEST_PATH: 'e2e/auth' });
    const vars = pipelineVariables('r1', { codes: ['TC-AUTH-001', 'TC-AUTH-002'] });
    expect(vars).toEqual({ EJAD_RUN_ID: 'r1', EJAD_TEST_GREP: '@TC-AUTH-001\\b|@TC-AUTH-002\\b' });
    // Playwright applies --grep as a JavaScript RegExp to the test title.
    expect(new RegExp(vars.EJAD_TEST_GREP).test('logs in @TC-AUTH-001')).toBe(true);
    expect(new RegExp(vars.EJAD_TEST_GREP).test('other @TC-AUTH-0010')).toBe(false);
  });

  it('names automated runs after the branch and time', () => {
    expect(automatedRunName('main', new Date('2026-09-18T09:05:30Z'))).toBe('Automated · main · 2026-09-18 09:05 UTC');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest run-scope`
Expected: FAIL with "Cannot find module './run-scope'".

- [ ] **Step 3: Implement the scope helpers**

`src/modules/automated-runs/run-scope.ts`:
```ts
export interface PipelineScope {
  /** Folder or file for `npx playwright test ${EJAD_TEST_PATH}`. */
  path?: string;
  /** Case codes turned into `--grep "${EJAD_TEST_GREP}"`. */
  codes?: string[];
}

/** Variables passed to POST /projects/:id/pipeline; the provided CI job runs only when EJAD_RUN_ID is set. */
export function pipelineVariables(runId: string, scope: PipelineScope): Record<string, string> {
  const variables: Record<string, string> = { EJAD_RUN_ID: runId };
  if (scope.path) variables.EJAD_TEST_PATH = scope.path;
  // \b keeps @TC-AUTH-001 from also matching @TC-AUTH-0010.
  if (scope.codes?.length) variables.EJAD_TEST_GREP = scope.codes.map((code) => `@${code}\\b`).join('|');
  return variables;
}

export function automatedRunName(branch: string, at: Date): string {
  return `Automated · ${branch} · ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
```

Run: `npx jest run-scope`
Expected: 2 tests pass.

- [ ] **Step 4: Write the failing e2e tests**

`test/automated-runs.e2e-spec.ts`:
```ts
import { FakeGitlab, FakeUser } from './utils/fake-gitlab';
import { seedActors, seedCase, seedModule } from './utils/factories';
import { createGitlabTestApp, GITLAB_PROJECT_ID as P, seedGitlabConnection, seedLinkedProject } from './utils/gitlab';
import { resetDb, TestContext } from './utils/test-app';

describe('Automated runs (e2e)', () => {
  let ctx: TestContext;
  let fake: FakeGitlab;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let tess: FakeUser;
  let projectId: string;
  let caseIds: string[];

  beforeAll(async () => {
    ({ ctx, fake } = await createGitlabTestApp());
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    fake.reset();
    actors = await seedActors(ctx);
    tess = (await seedGitlabConnection(ctx, fake, actors.tester.id, { username: 'tess' })).gitlabUser;
    projectId = (await seedLinkedProject(ctx, fake, actors.admin.id, [tess])).project.id;
    const moduleId = (await seedModule(ctx.prisma, projectId)).id;
    caseIds = [
      (await seedCase(ctx.prisma, { projectId, moduleId, userId: actors.admin.id, code: 'TC-AUTH-001' })).id,
      (await seedCase(ctx.prisma, { projectId, moduleId, userId: actors.admin.id, code: 'TC-AUTH-002' })).id,
    ];
  });
  afterAll(async () => {
    await ctx.app.close();
    await fake.close();
  });

  const trigger = (body: Record<string, unknown>, auth = actors.testerAuth) =>
    ctx.http().post(`/api/projects/${projectId}/runs/automated`).set(auth).send(body);

  it('starts a pipeline as the user for all tests', async () => {
    const res = await trigger({ branch: 'main', scope: { mode: 'ALL' } }).expect(201);
    const [pipeline] = fake.pipelines;
    expect(res.body).toMatchObject({
      type: 'AUTOMATED',
      status: 'IN_PROGRESS',
      branch: 'main',
      triggeredById: actors.tester.id,
      triggeredBy: { id: actors.tester.id, name: 'Tess Tester' },
      pipelineId: pipeline.id,
      pipelineWebUrl: `${fake.url}/mobile/ninja-store/-/pipelines/${pipeline.id}`,
      pipelineStatus: 'created',
      note: null,
      results: [],
    });
    expect(res.body.name).toMatch(/^Automated · main · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    expect(pipeline).toMatchObject({ project_id: P, ref: 'main', userId: tess.id, variables: { EJAD_RUN_ID: res.body.id } });
  });

  it('scopes a run to a folder or file inside the tests folder', async () => {
    const res = await trigger({ branch: 'main', name: 'Auth only', scope: { mode: 'PATH', path: 'e2e/auth' } }).expect(201);
    expect(res.body.name).toBe('Auth only');
    expect(fake.pipelines[0].variables).toEqual({ EJAD_RUN_ID: res.body.id, EJAD_TEST_PATH: 'e2e/auth' });

    const outside = await trigger({ branch: 'main', scope: { mode: 'PATH', path: 'src' } }).expect(400);
    expect(outside.body.message).toBe('Path must be inside the tests folder "e2e"');
    const missing = await trigger({ branch: 'main', scope: { mode: 'PATH' } }).expect(400);
    expect(missing.body.message).toBe('scope.path is required for mode PATH');
    expect(await ctx.prisma.testRun.count()).toBe(1);
  });

  it('scopes a run to selected cases with a grep and pre-created results', async () => {
    const res = await trigger({ branch: 'main', scope: { mode: 'CASES', caseIds: [caseIds[1], caseIds[0]] } }).expect(201);
    expect(fake.pipelines[0].variables).toEqual({ EJAD_RUN_ID: res.body.id, EJAD_TEST_GREP: '@TC-AUTH-001\\b|@TC-AUTH-002\\b' });
    expect(res.body.summary).toMatchObject({ total: 2, notExecuted: 2 });
    expect(res.body.results.map((r: { testCase: { code: string } }) => r.testCase.code)).toEqual(['TC-AUTH-001', 'TC-AUTH-002']);

    const missing = await trigger({ branch: 'main', scope: { mode: 'CASES' } }).expect(400);
    expect(missing.body.message).toBe('scope.caseIds is required for mode CASES');
    const foreign = await trigger({ branch: 'main', scope: { mode: 'CASES', caseIds: ['7a1d0c5e-0000-4000-8000-000000000000'] } }).expect(400);
    expect(foreign.body.message).toBe('Some selected test cases do not exist in this project');
    await trigger({ branch: 'bad branch', scope: { mode: 'ALL' } }).expect(400);
  });

  it("closes the run with GitLab's message when the pipeline cannot be created", async () => {
    fake.projects.get(P)!.ciEnabled = false;
    const res = await trigger({ branch: 'main', scope: { mode: 'ALL' } }).expect(201);
    expect(res.body).toMatchObject({
      status: 'COMPLETED',
      pipelineId: null,
      note: 'GitLab could not start the pipeline: Pipeline will not run for the selected trigger. The rules configuration prevented any jobs from being added to the pipeline.',
    });
    expect(res.body.completedAt).not.toBeNull();
  });

  it('requires a GitLab connection before creating a run', async () => {
    const res = await trigger({ branch: 'main', scope: { mode: 'ALL' } }, actors.adminAuth).expect(403);
    expect(res.body.details).toEqual({ code: 'GITLAB_NOT_CONNECTED' });
    expect(await ctx.prisma.testRun.count()).toBe(0);
    expect(fake.pipelines).toHaveLength(0);
  });
});
```

Add this test at the end of the `describe` in `test/gitlab-disabled.e2e-spec.ts`:
```ts
  it('hides the automated run trigger', async () => {
    const project = await seedProject(ctx.prisma, actors.admin.id, { key: 'RUNS' });
    await expectHidden('post', `/api/projects/${project.id}/runs/automated`, { branch: 'main', scope: { mode: 'ALL' } });
  });
```

- [ ] **Step 5: Run them to verify they fail**

Run: `npm run test:e2e -- automated-runs gitlab-disabled`
Expected: FAIL (404 "Cannot POST /api/projects/…/runs/automated").

- [ ] **Step 6: Implement the DTO, service, controller and module**

`src/modules/automated-runs/dto/create-automated-run.dto.ts`:
```ts
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDefined, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { BRANCH_NAME_RE } from '../../automation/paths';

export const AUTOMATED_SCOPE_MODES = ['ALL', 'PATH', 'CASES'] as const;
export type AutomatedScopeMode = (typeof AUTOMATED_SCOPE_MODES)[number];

export class AutomatedScopeDto {
  @IsIn(AUTOMATED_SCOPE_MODES)
  mode!: AutomatedScopeMode;

  /** Folder or file inside the tests folder (mode PATH). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  path?: string;

  /** Test cases to run by their @TC tag (mode CASES). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  caseIds?: string[];
}

export class CreateAutomatedRunDto {
  @IsString()
  @Matches(BRANCH_NAME_RE, { message: 'branch is not a valid branch name' })
  branch!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name?: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => AutomatedScopeDto)
  scope!: AutomatedScopeDto;
}
```

`src/modules/automated-runs/automated-runs.service.ts`:
```ts
import { BadRequestException, Injectable } from '@nestjs/common';
import { RunStatus, RunType } from '@prisma/client';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationService, LinkedProject } from '../automation/automation.service';
import { resolveInTestsPath } from '../automation/paths';
import { GitlabApiService } from '../gitlab/gitlab-api.service';
import { GitlabConnectionService } from '../gitlab/gitlab-connection.service';
import { GitlabHttpError } from '../gitlab/gitlab-http-error';
import { RunsService } from '../runs/runs.service';
import { AutomatedScopeDto, CreateAutomatedRunDto } from './dto/create-automated-run.dto';
import { automatedRunName, pipelineVariables } from './run-scope';

interface ResolvedScope {
  path?: string;
  cases: { id: string; code: string }[];
}

@Injectable()
export class AutomatedRunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly automation: AutomationService,
    private readonly gitlab: GitlabConnectionService,
    private readonly api: GitlabApiService,
    private readonly runs: RunsService,
  ) {}

  /** Creates an AUTOMATED run and starts a GitLab pipeline for it with the caller's token. */
  async trigger(projectId: string, dto: CreateAutomatedRunDto, user: AuthUser) {
    const project = await this.automation.requireLinked(projectId);
    const scope = await this.resolveScope(project, dto.scope);
    // 403 before any run exists when the user has no usable GitLab connection.
    const token = await this.gitlab.accessToken(user.id);

    const run = await this.prisma.$transaction(async (tx) => {
      const created = await tx.testRun.create({
        data: {
          projectId,
          name: dto.name ?? automatedRunName(dto.branch, new Date()),
          type: RunType.AUTOMATED,
          branch: dto.branch,
          triggeredById: user.id,
          createdById: user.id,
        },
        select: { id: true },
      });
      if (scope.cases.length) {
        await tx.testResult.createMany({ data: scope.cases.map((c) => ({ runId: created.id, testCaseId: c.id })) });
      }
      return created;
    });

    try {
      const pipeline = await this.api.createPipeline(
        token,
        project.gitlabProjectId,
        dto.branch,
        pipelineVariables(run.id, { path: scope.path, codes: scope.cases.map((c) => c.code) }),
      );
      await this.prisma.testRun.update({
        where: { id: run.id },
        data: { pipelineId: pipeline.id, pipelineWebUrl: pipeline.webUrl, pipelineStatus: pipeline.status },
        select: { id: true },
      });
    } catch (e) {
      if (e instanceof GitlabHttpError && e.status === 401) await this.gitlab.markNeedsReconnect(user.id);
      const message = e instanceof GitlabHttpError ? e.message : 'Unexpected error';
      await this.prisma.testRun.update({
        where: { id: run.id },
        data: { status: RunStatus.COMPLETED, completedAt: new Date(), note: `GitLab could not start the pipeline: ${message}` },
        select: { id: true },
      });
      if (!(e instanceof GitlabHttpError)) throw e;
    }
    return this.runs.findOne(run.id);
  }

  private async resolveScope(project: LinkedProject, scope: AutomatedScopeDto): Promise<ResolvedScope> {
    switch (scope.mode) {
      case 'PATH':
        if (!scope.path) throw new BadRequestException('scope.path is required for mode PATH');
        return { path: resolveInTestsPath(project.testsPath, scope.path), cases: [] };
      case 'CASES': {
        const ids = [...new Set(scope.caseIds ?? [])];
        if (!ids.length) throw new BadRequestException('scope.caseIds is required for mode CASES');
        const cases = await this.prisma.testCase.findMany({
          where: { id: { in: ids }, projectId: project.id, deletedAt: null },
          select: { id: true, code: true },
          orderBy: { code: 'asc' },
        });
        if (cases.length !== ids.length) throw new BadRequestException('Some selected test cases do not exist in this project');
        return { cases };
      }
      default:
        return { cases: [] };
    }
  }
}
```

`src/modules/automated-runs/automated-runs.controller.ts`:
```ts
import { Body, Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { GitlabEnabledGuard } from '../gitlab/gitlab-enabled.guard';
import { AutomatedRunsService } from './automated-runs.service';
import { CreateAutomatedRunDto } from './dto/create-automated-run.dto';

@ApiTags('Automation')
@ApiBearerAuth()
@UseGuards(GitlabEnabledGuard)
@Controller()
export class AutomatedRunsController {
  constructor(private readonly automatedRuns: AutomatedRunsService) {}

  @Post('projects/:projectId/runs/automated')
  trigger(@Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: CreateAutomatedRunDto, @CurrentUser() user: AuthUser) {
    return this.automatedRuns.trigger(projectId, dto, user);
  }
}
```

`src/modules/automated-runs/automated-runs.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AutomationModule } from '../automation/automation.module';
import { GitlabModule } from '../gitlab/gitlab.module';
import { RunsModule } from '../runs/runs.module';
import { AutomatedRunsController } from './automated-runs.controller';
import { AutomatedRunsService } from './automated-runs.service';

@Module({
  imports: [GitlabModule, AutomationModule, RunsModule],
  controllers: [AutomatedRunsController],
  providers: [AutomatedRunsService],
})
export class AutomatedRunsModule {}
```

In `src/modules/runs/runs.module.ts`, add `exports: [RunsService],` after `providers`.

In `src/modules/runs/runs.service.ts`, in `findOne`, add `triggeredBy: USER_REF,` to the `include` object right after `createdBy: USER_REF,`.

In `src/app.module.ts`, import `AutomatedRunsModule` from `./modules/automated-runs/automated-runs.module` and add it to `imports` after `AutomationModule`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run test:e2e -- automated-runs gitlab-disabled runs && npm run typecheck && npm test && npm run test:e2e`
Expected: `automated-runs` 5, `gitlab-disabled` 5 and the Phase 1 `runs` tests pass. Then unit `Tests: 89 passed`, and e2e `Tests: 112 passed, 112 total`, with no warnings.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: trigger automated runs as GitLab pipelines with scope variables

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Pipeline poller and test-report import

**Files:**
- Create: `src/modules/automated-runs/report-mapper.ts`, `src/modules/automated-runs/result-importer.service.ts`, `src/modules/automated-runs/pipeline-poller.service.ts`
- Modify: `package.json` (+ `@nestjs/schedule`), `src/app.module.ts` (`ScheduleModule.forRoot()`), `src/modules/automated-runs/automated-runs.module.ts`
- Test: `src/modules/automated-runs/report-mapper.spec.ts`, `test/pipeline-import.e2e-spec.ts`

**Interfaces:**
- Consumes: `extractCaseTags` (Task 5); `GitlabTestSuite`, `GitlabTestCase`, `GitlabPipeline`, `FINAL_PIPELINE_STATUSES`, `GitlabApiService.getPipeline/getTestReport/listPipelineJobs`, `GitlabConnectionService.withToken` (Tasks 2–3); `GitlabConfig.pollIntervalMs/runTimeoutMs` (Task 1); runs created by Task 7.
- Produces:
  - `MAX_ERROR_LENGTH = 10000`, `truncate(text: string | null, max: number): string | null`, `mapTestStatus(status: string): ResultStatus` (`success → PASSED`, `failed|error → FAILED`, anything else → `SKIPPED`), `MappedResult { status; title; file: string | null; durationMs; errorMessage: string | null; errorStack: string | null }`, `LinkedResult extends MappedResult { testCaseId; code }`, `mapTestReport(suites: GitlabTestSuite[], caseIdsByCode: Map<string, string>): { linked: LinkedResult[]; unlinked: MappedResult[] }`.
  - `ResultImporterService.close(runId, note, pipelineStatus?): Promise<void>` and `ResultImporterService.importPipeline(token, runId, pipeline: GitlabPipeline): Promise<void>`. On import: tagged tests fill the case results (`executedAt` = pipeline `finished_at`, `executedById` = the triggering user, `artifactsUrl` = `<gitlabWebUrl>/-/jobs/<jobId>/artifacts/browse` on FAILED results); untagged/unknown tests become results with `testCaseId = null`; selected cases with no test keep NOT_EXECUTED with notes `No automated test found`; the run becomes `COMPLETED`. With no report, the run is completed with note `Pipeline finished without a test report – <job url>`.
  - `PIPELINE_POLLER = 'gitlab-pipeline-poller'`. `PipelinePollerService.pollOnce(): Promise<void>` runs as an interval every `GITLAB_POLL_INTERVAL_MS` (default 20 000 ms; `0` = off). It uses the triggering user's token, skips runs whose user needs to reconnect, and closes runs older than `GITLAB_RUN_TIMEOUT_MINUTES` (default 120) with note `Timed out waiting for GitLab`.

- [ ] **Step 1: Install the scheduler**

```bash
cd /c/Users/User/StudioProjects/ejad-testcases-api
npm install @nestjs/schedule@^4
```
Expected: `@nestjs/schedule` 4.x is added to `dependencies` (its peer range covers Nest 10). No other package changes.

- [ ] **Step 2: Write the failing mapper unit test**

`src/modules/automated-runs/report-mapper.spec.ts`:
```ts
import { ResultStatus } from '@prisma/client';
import { GitlabTestCase, GitlabTestSuite } from '../gitlab/gitlab.types';
import { mapTestReport, mapTestStatus } from './report-mapper';

const CODES = new Map([
  ['TC-AUTH-001', 'c1'],
  ['TC-AUTH-002', 'c2'],
]);

const tc = (data: Partial<GitlabTestCase>): GitlabTestCase => ({
  status: 'success',
  name: 't',
  classname: 'auth/login.spec.ts',
  file: 'e2e/auth/login.spec.ts',
  executionTime: 1.5,
  systemOutput: null,
  stackTrace: null,
  ...data,
});
const suites = (...cases: GitlabTestCase[]): GitlabTestSuite[] => [{ name: 'chromium', cases }];

describe('mapTestReport', () => {
  it('fills the tagged case from a passing test', () => {
    const report = mapTestReport(suites(tc({ name: 'login › logs in @TC-AUTH-001', executionTime: 1.234 })), CODES);
    expect(report).toEqual({
      linked: [
        {
          testCaseId: 'c1',
          code: 'TC-AUTH-001',
          status: ResultStatus.PASSED,
          title: 'login › logs in @TC-AUTH-001',
          file: 'e2e/auth/login.spec.ts',
          durationMs: 1234,
          errorMessage: null,
          errorStack: null,
        },
      ],
      unlinked: [],
    });
  });

  it('maps failed and error tests to FAILED with a truncated message', () => {
    const report = mapTestReport(
      suites(
        tc({ status: 'failed', name: 'a @TC-AUTH-001', systemOutput: 'x'.repeat(20_000), stackTrace: 'at a.spec.ts:3' }),
        tc({ status: 'error', name: 'b @TC-AUTH-002', stackTrace: 'boom' }),
      ),
      CODES,
    );
    const [first, second] = report.linked;
    expect(first.status).toBe(ResultStatus.FAILED);
    expect(first.errorMessage).toHaveLength(10_000);
    expect(first.errorMessage!.endsWith('…')).toBe(true);
    expect(first.errorStack).toBe('at a.spec.ts:3');
    expect(second).toMatchObject({ status: ResultStatus.FAILED, errorMessage: 'boom' });
    expect(mapTestStatus('success')).toBe(ResultStatus.PASSED);
    expect(mapTestStatus('skipped')).toBe(ResultStatus.SKIPPED);
  });

  it('maps skipped tests to SKIPPED without an error', () => {
    const report = mapTestReport(suites(tc({ status: 'skipped', name: 's @TC-AUTH-001', systemOutput: 'skipped because' })), CODES);
    expect(report.linked[0]).toMatchObject({ status: ResultStatus.SKIPPED, errorMessage: null, errorStack: null });
  });

  it('combines several tests of one case: FAILED if any failed, else PASSED if any passed', () => {
    const report = mapTestReport(
      suites(
        tc({ name: 'p @TC-AUTH-001', executionTime: 0.5 }),
        tc({ status: 'failed', name: 'f @TC-AUTH-001', executionTime: 1, systemOutput: 'expected 1' }),
        tc({ status: 'skipped', name: 's @TC-AUTH-002' }),
        tc({ name: 'p2 @TC-AUTH-002' }),
      ),
      CODES,
    );
    expect(report.linked).toEqual([
      expect.objectContaining({ testCaseId: 'c1', status: ResultStatus.FAILED, durationMs: 1500, errorMessage: 'expected 1', title: 'p @TC-AUTH-001 | f @TC-AUTH-001' }),
      expect.objectContaining({ testCaseId: 'c2', status: ResultStatus.PASSED }),
    ]);
    const skippedOnly = mapTestReport(suites(tc({ status: 'skipped', name: 'a @TC-AUTH-001' }), tc({ status: 'skipped', name: 'b @TC-AUTH-001' })), CODES);
    expect(skippedOnly.linked[0].status).toBe(ResultStatus.SKIPPED);
  });

  it('keeps untagged tests and unknown codes as unlinked results', () => {
    const report = mapTestReport(
      suites(
        tc({ name: 'cart › adds an item', file: null, classname: 'cart/cart.spec.ts' }),
        tc({ status: 'skipped', name: 'legacy @TC-OLD-001' }),
      ),
      CODES,
    );
    expect(report.linked).toEqual([]);
    expect(report.unlinked).toEqual([
      { status: ResultStatus.PASSED, title: 'cart › adds an item', file: 'cart/cart.spec.ts', durationMs: 1500, errorMessage: null, errorStack: null },
      { status: ResultStatus.SKIPPED, title: 'legacy @TC-OLD-001', file: 'e2e/auth/login.spec.ts', durationMs: 1500, errorMessage: null, errorStack: null },
    ]);
  });

  it('fills every case a test is tagged with', () => {
    const report = mapTestReport(suites(tc({ name: 'login and error @TC-AUTH-001 @TC-AUTH-002' })), CODES);
    expect(report.linked.map((l) => [l.code, l.status])).toEqual([
      ['TC-AUTH-001', ResultStatus.PASSED],
      ['TC-AUTH-002', ResultStatus.PASSED],
    ]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx jest report-mapper`
Expected: FAIL with "Cannot find module './report-mapper'".

- [ ] **Step 4: Implement the mapper**

`src/modules/automated-runs/report-mapper.ts`:
```ts
import { ResultStatus } from '@prisma/client';
import { extractCaseTags } from '../automation/case-tags';
import { GitlabTestCase, GitlabTestSuite } from '../gitlab/gitlab.types';

export const MAX_ERROR_LENGTH = 10_000;
const MAX_TITLE_LENGTH = 1000;

export interface MappedResult {
  status: ResultStatus;
  title: string;
  file: string | null;
  durationMs: number;
  errorMessage: string | null;
  errorStack: string | null;
}

export interface LinkedResult extends MappedResult {
  testCaseId: string;
  code: string;
}

export function truncate(text: string | null, max: number): string | null {
  if (text === null) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function mapTestStatus(status: string): ResultStatus {
  switch (status) {
    case 'success':
      return ResultStatus.PASSED;
    case 'failed':
    case 'error':
      return ResultStatus.FAILED;
    default:
      return ResultStatus.SKIPPED;
  }
}

function mapCase(testCase: GitlabTestCase, suite: GitlabTestSuite): MappedResult {
  const status = mapTestStatus(testCase.status);
  const failed = status === ResultStatus.FAILED;
  return {
    status,
    title: truncate(testCase.name, MAX_TITLE_LENGTH)!,
    file: testCase.file ?? (testCase.classname || suite.name || null),
    durationMs: Math.round(testCase.executionTime * 1000),
    errorMessage: failed ? truncate(testCase.systemOutput ?? testCase.stackTrace ?? 'Test failed', MAX_ERROR_LENGTH) : null,
    errorStack: failed ? truncate(testCase.stackTrace, MAX_ERROR_LENGTH) : null,
  };
}

/** Several tests for one case: FAILED if any failed, else PASSED if any passed, else SKIPPED. */
function aggregate(testCaseId: string, code: string, tests: MappedResult[]): LinkedResult {
  const failed = tests.filter((t) => t.status === ResultStatus.FAILED);
  const status = failed.length
    ? ResultStatus.FAILED
    : tests.some((t) => t.status === ResultStatus.PASSED)
      ? ResultStatus.PASSED
      : ResultStatus.SKIPPED;
  const files = [...new Set(tests.map((t) => t.file).filter((f): f is string => !!f))];
  const errorMessage =
    failed.length === 0
      ? null
      : failed.length === 1
        ? failed[0].errorMessage
        : truncate(failed.map((t) => `${t.title}: ${t.errorMessage ?? ''}`).join('\n\n'), MAX_ERROR_LENGTH);
  return {
    testCaseId,
    code,
    status,
    title: truncate(tests.map((t) => t.title).join(' | '), MAX_TITLE_LENGTH)!,
    file: files.length ? files.join(', ') : null,
    durationMs: tests.reduce((sum, t) => sum + t.durationMs, 0),
    errorMessage,
    errorStack: failed[0]?.errorStack ?? null,
  };
}

/**
 * Maps GitLab's pipeline test report to run results. A test whose name carries @TC-<CODE> of an
 * active case of the project fills that case; everything else becomes an unlinked result.
 */
export function mapTestReport(
  suites: GitlabTestSuite[],
  caseIdsByCode: Map<string, string>,
): { linked: LinkedResult[]; unlinked: MappedResult[] } {
  const groups = new Map<string, { code: string; tests: MappedResult[] }>();
  const unlinked: MappedResult[] = [];
  for (const suite of suites) {
    for (const testCase of suite.cases) {
      const mapped = mapCase(testCase, suite);
      const codes = extractCaseTags(testCase.name).filter((code) => caseIdsByCode.has(code));
      if (!codes.length) {
        unlinked.push(mapped);
        continue;
      }
      for (const code of codes) {
        const testCaseId = caseIdsByCode.get(code)!;
        const group = groups.get(testCaseId) ?? { code, tests: [] };
        group.tests.push(mapped);
        groups.set(testCaseId, group);
      }
    }
  }
  return {
    linked: [...groups].map(([testCaseId, group]) => aggregate(testCaseId, group.code, group.tests)),
    unlinked,
  };
}
```

Run: `npx jest report-mapper`
Expected: 6 tests pass.

- [ ] **Step 5: Write the failing e2e tests**

`test/pipeline-import.e2e-spec.ts`:
```ts
import { SchedulerRegistry } from '@nestjs/schedule';
import { PIPELINE_POLLER, PipelinePollerService } from '../src/modules/automated-runs/pipeline-poller.service';
import { FakeGitlab, FakeTestReport } from './utils/fake-gitlab';
import { seedActors, seedCase, seedModule } from './utils/factories';
import { createGitlabTestApp, seedGitlabConnection, seedLinkedProject } from './utils/gitlab';
import { createTestApp, resetDb, TestContext } from './utils/test-app';

const REPORT: FakeTestReport = {
  total_count: 5,
  test_suites: [
    {
      name: 'chromium',
      test_cases: [
        {
          status: 'success',
          name: 'auth/login.spec.ts › logs in with valid credentials @TC-AUTH-001',
          classname: 'auth/login.spec.ts',
          file: 'e2e/auth/login.spec.ts',
          execution_time: 1.234,
        },
        {
          status: 'failed',
          name: 'auth/login.spec.ts › shows an error for a wrong password @TC-AUTH-002',
          classname: 'auth/login.spec.ts',
          file: 'e2e/auth/login.spec.ts',
          execution_time: 1,
          system_output: 'Error: expect(received).toBeVisible()',
          stack_trace: 'at e2e/auth/login.spec.ts:9:5',
        },
        {
          status: 'success',
          name: 'auth/login.spec.ts › remembers the user @TC-AUTH-002',
          classname: 'auth/login.spec.ts',
          file: 'e2e/auth/login.spec.ts',
          execution_time: 0.5,
        },
        {
          status: 'success',
          name: 'cart/cart.spec.ts › adds an item to the cart',
          classname: 'cart/cart.spec.ts',
          file: 'e2e/cart/cart.spec.ts',
          execution_time: 2,
        },
        { status: 'skipped', name: 'legacy › old checkout @TC-OLD-001', classname: 'legacy.spec.ts', file: null, execution_time: 0 },
      ],
    },
  ],
};

interface RunResult {
  id: string;
  title: string | null;
  testCaseId: string | null;
  testCase: { code: string } | null;
}

describe('Pipeline polling and result import (e2e)', () => {
  let ctx: TestContext;
  let fake: FakeGitlab;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let tessToken: string;
  let projectId: string;
  let caseIds: string[];

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
    const moduleId = (await seedModule(ctx.prisma, projectId)).id;
    caseIds = [];
    for (const code of ['TC-AUTH-001', 'TC-AUTH-002', 'TC-AUTH-003']) {
      caseIds.push((await seedCase(ctx.prisma, { projectId, moduleId, userId: actors.admin.id, code })).id);
    }
  });
  afterAll(async () => {
    await ctx.app.close();
    await fake.close();
  });

  const poll = () => ctx.app.get(PipelinePollerService).pollOnce();
  const trigger = async (scope: Record<string, unknown>) =>
    (await ctx.http().post(`/api/projects/${projectId}/runs/automated`).set(actors.testerAuth).send({ branch: 'main', scope }).expect(201))
      .body as { id: string; pipelineId: number };
  const detail = async (runId: string) => (await ctx.http().get(`/api/runs/${runId}`).set(actors.testerAuth).expect(200)).body;

  it('tracks the pipeline status with the triggering user token', async () => {
    const run = await trigger({ mode: 'ALL' });
    fake.setPipelineStatus(run.pipelineId, 'running');
    await poll();
    expect(await detail(run.id)).toMatchObject({ status: 'IN_PROGRESS', pipelineStatus: 'running' });
    expect(fake.requestsTo(`/pipelines/${run.pipelineId}`, 'GET')[0].token).toBe(tessToken);
  });

  it('imports the finished test report into results and completes the run', async () => {
    const run = await trigger({ mode: 'CASES', caseIds });
    fake.finishPipeline(run.pipelineId, 'failed', REPORT);
    await poll();

    const body = await detail(run.id);
    const artifacts = `${fake.url}/mobile/ninja-store/-/jobs/${500 + run.pipelineId}/artifacts/browse`;
    expect(body).toMatchObject({ status: 'COMPLETED', pipelineStatus: 'failed', note: null });
    expect(body.completedAt).not.toBeNull();
    expect(body.summary).toMatchObject({ total: 5, passed: 2, failed: 1, skipped: 1, notExecuted: 1 });

    const results = Object.fromEntries((body.results as RunResult[]).map((r) => [r.testCase?.code ?? r.title, r]));
    expect(results['TC-AUTH-001']).toMatchObject({
      status: 'PASSED',
      durationMs: 1234,
      file: 'e2e/auth/login.spec.ts',
      artifactsUrl: null,
      executedAt: '2026-09-18T10:00:00.000Z',
      executedBy: { id: actors.tester.id, name: 'Tess Tester' },
    });
    expect(results['TC-AUTH-002']).toMatchObject({
      status: 'FAILED',
      durationMs: 1500,
      errorMessage: 'Error: expect(received).toBeVisible()',
      errorStack: 'at e2e/auth/login.spec.ts:9:5',
      artifactsUrl: artifacts,
    });
    expect(results['TC-AUTH-003']).toMatchObject({ status: 'NOT_EXECUTED', notes: 'No automated test found', executedBy: null });
    expect(results['cart/cart.spec.ts › adds an item to the cart']).toMatchObject({
      testCaseId: null,
      testCase: null,
      status: 'PASSED',
      file: 'e2e/cart/cart.spec.ts',
    });
    expect(results['legacy › old checkout @TC-OLD-001']).toMatchObject({ testCaseId: null, status: 'SKIPPED', file: 'legacy.spec.ts' });

    // Imported runs are read-only and are not imported twice.
    await ctx.http().patch(`/api/runs/${run.id}/results/${results['TC-AUTH-003'].id}`).set(actors.testerAuth).send({ status: 'PASSED' }).expect(409);
    await poll();
    expect(await ctx.prisma.testResult.count({ where: { runId: run.id } })).toBe(5);
    expect(fake.requestsTo('/test_report')).toHaveLength(1);
  });

  it('completes the run with a note when the pipeline has no test report', async () => {
    const run = await trigger({ mode: 'ALL' });
    fake.finishPipeline(run.pipelineId, 'failed', null);
    await poll();
    expect(await detail(run.id)).toMatchObject({
      status: 'COMPLETED',
      pipelineStatus: 'failed',
      note: `Pipeline finished without a test report – ${fake.url}/mobile/ninja-store/-/jobs/${500 + run.pipelineId}`,
      results: [],
    });
  });

  it('times out runs that GitLab never finishes', async () => {
    const run = await trigger({ mode: 'ALL' });
    await ctx.prisma.testRun.update({ where: { id: run.id }, data: { startedAt: new Date(Date.now() - 3 * 3_600_000) } });
    await poll();
    expect(await detail(run.id)).toMatchObject({ status: 'COMPLETED', note: 'Timed out waiting for GitLab' });
    expect(fake.requestsTo(`/pipelines/${run.pipelineId}`, 'GET')).toHaveLength(0);
  });

  it('pauses polling while the triggering user must reconnect', async () => {
    const run = await trigger({ mode: 'ALL' });
    fake.finishPipeline(run.pipelineId, 'success', REPORT);
    await ctx.prisma.gitlabConnection.update({ where: { userId: actors.tester.id }, data: { state: 'NEEDS_RECONNECT' } });
    await poll();
    expect((await detail(run.id)).status).toBe('IN_PROGRESS');
    expect(fake.requestsTo(`/pipelines/${run.pipelineId}`, 'GET')).toHaveLength(0);

    await ctx.prisma.gitlabConnection.update({ where: { userId: actors.tester.id }, data: { state: 'ACTIVE' } });
    await poll();
    expect((await detail(run.id)).status).toBe('COMPLETED');
  });

  it('registers the polling interval only when it is enabled', async () => {
    expect(ctx.app.get(SchedulerRegistry).doesExist('interval', PIPELINE_POLLER)).toBe(false);
    const polling = await createTestApp({ GITLAB_URL: fake.url, GITLAB_POLL_INTERVAL_MS: '20000' });
    try {
      expect(polling.app.get(SchedulerRegistry).doesExist('interval', PIPELINE_POLLER)).toBe(true);
    } finally {
      await polling.app.close();
    }
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npm run test:e2e -- pipeline-import`
Expected: FAIL with "Cannot find module '../src/modules/automated-runs/pipeline-poller.service'".

- [ ] **Step 7: Implement the importer and the poller**

`src/modules/automated-runs/result-importer.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { ResultStatus, RunStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { GitlabApiService } from '../gitlab/gitlab-api.service';
import { GitlabPipeline } from '../gitlab/gitlab.types';
import { mapTestReport, MappedResult } from './report-mapper';

export const NO_TEST_FOUND_NOTE = 'No automated test found';

@Injectable()
export class ResultImporterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly api: GitlabApiService,
  ) {}

  /** Completes a still-running automated run with a note (timeouts, missing reports, removed links). */
  async close(runId: string, note: string, pipelineStatus?: string): Promise<void> {
    await this.prisma.testRun.updateMany({
      where: { id: runId, status: RunStatus.IN_PROGRESS },
      data: { status: RunStatus.COMPLETED, completedAt: new Date(), note, ...(pipelineStatus ? { pipelineStatus } : {}) },
    });
  }

  /** Reads a finished pipeline's test report (as the triggering user) and completes the run with its results. */
  async importPipeline(token: string, runId: string, pipeline: GitlabPipeline): Promise<void> {
    const run = await this.prisma.testRun.findUniqueOrThrow({
      where: { id: runId },
      select: { projectId: true, triggeredById: true, project: { select: { gitlabProjectId: true, gitlabWebUrl: true } } },
    });
    const gitlabProjectId = run.project.gitlabProjectId;
    if (gitlabProjectId === null) {
      await this.close(runId, 'The repository link was removed', pipeline.status);
      return;
    }
    const suites = await this.api.getTestReport(token, gitlabProjectId, pipeline.id);
    const jobs = await this.api.listPipelineJobs(token, gitlabProjectId, pipeline.id);
    const job = jobs.find((j) => j.name === 'ejad-playwright') ?? jobs[0];
    if (!suites.some((s) => s.cases.length)) {
      await this.close(runId, `Pipeline finished without a test report – ${job?.webUrl ?? pipeline.webUrl}`, pipeline.status);
      return;
    }

    const artifactsUrl = job && run.project.gitlabWebUrl ? `${run.project.gitlabWebUrl}/-/jobs/${job.id}/artifacts/browse` : null;
    const executedAt = pipeline.finishedAt ? new Date(pipeline.finishedAt) : new Date();
    const cases = await this.prisma.testCase.findMany({ where: { projectId: run.projectId, deletedAt: null }, select: { id: true, code: true } });
    const report = mapTestReport(suites, new Map(cases.map((c) => [c.code, c.id])));
    const fields = (r: MappedResult) => ({
      status: r.status,
      title: r.title,
      file: r.file,
      durationMs: r.durationMs,
      errorMessage: r.errorMessage,
      errorStack: r.errorStack,
      artifactsUrl: r.status === ResultStatus.FAILED ? artifactsUrl : null,
      executedAt,
      executedById: run.triggeredById,
    });

    // Sequential writes only: parallel queries inside a transaction trigger the pg deprecation warning.
    await this.prisma.$transaction(
      async (tx) => {
        const [locked] = await tx.$queryRaw<{ status: RunStatus }[]>`
          SELECT status FROM "TestRun" WHERE id = ${runId} FOR UPDATE`;
        if (locked?.status !== RunStatus.IN_PROGRESS) return;

        const existing = await tx.testResult.findMany({ where: { runId, testCaseId: { not: null } }, select: { id: true, testCaseId: true } });
        const resultByCase = new Map(existing.map((r) => [r.testCaseId!, r.id]));
        for (const linked of report.linked) {
          const id = resultByCase.get(linked.testCaseId);
          if (id) await tx.testResult.update({ where: { id }, data: fields(linked), select: { id: true } });
          else await tx.testResult.create({ data: { runId, testCaseId: linked.testCaseId, ...fields(linked) }, select: { id: true } });
        }
        if (report.unlinked.length) {
          await tx.testResult.createMany({ data: report.unlinked.map((u) => ({ runId, testCaseId: null, ...fields(u) })) });
        }
        const linkedIds = new Set(report.linked.map((l) => l.testCaseId));
        const missing = existing.filter((r) => !linkedIds.has(r.testCaseId!)).map((r) => r.id);
        if (missing.length) {
          await tx.testResult.updateMany({ where: { id: { in: missing } }, data: { notes: NO_TEST_FOUND_NOTE } });
        }
        await tx.testRun.update({
          where: { id: runId },
          data: { status: RunStatus.COMPLETED, completedAt: new Date(), pipelineStatus: pipeline.status },
          select: { id: true },
        });
      },
      { timeout: 60_000 },
    );
  }
}
```

`src/modules/automated-runs/pipeline-poller.service.ts`:
```ts
import { HttpException, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { GitlabConnectionState, RunStatus, RunType } from '@prisma/client';
import { GitlabConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { GitlabApiService } from '../gitlab/gitlab-api.service';
import { GitlabConnectionService } from '../gitlab/gitlab-connection.service';
import { FINAL_PIPELINE_STATUSES } from '../gitlab/gitlab.types';
import { ResultImporterService } from './result-importer.service';

export const PIPELINE_POLLER = 'gitlab-pipeline-poller';

interface PolledRun {
  id: string;
  startedAt: Date;
  pipelineId: number | null;
  pipelineStatus: string | null;
  triggeredById: string | null;
  project: { gitlabProjectId: number | null };
}

@Injectable()
export class PipelinePollerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PipelinePollerService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly scheduler: SchedulerRegistry,
    private readonly gitlab: GitlabConnectionService,
    private readonly api: GitlabApiService,
    private readonly importer: ResultImporterService,
  ) {}

  private get cfg(): GitlabConfig {
    return this.config.getOrThrow<GitlabConfig>('gitlab');
  }

  onApplicationBootstrap(): void {
    if (!this.cfg.enabled || this.cfg.pollIntervalMs <= 0) return;
    this.scheduler.addInterval(PIPELINE_POLLER, setInterval(() => void this.pollOnce(), this.cfg.pollIntervalMs));
  }

  onApplicationShutdown(): void {
    if (this.scheduler.doesExist('interval', PIPELINE_POLLER)) this.scheduler.deleteInterval(PIPELINE_POLLER);
  }

  /** One pass over all unfinished automated runs (the interval calls this; tests call it directly). */
  async pollOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const runs: PolledRun[] = await this.prisma.testRun.findMany({
        where: { type: RunType.AUTOMATED, status: RunStatus.IN_PROGRESS, pipelineId: { not: null } },
        orderBy: { startedAt: 'asc' },
        select: {
          id: true,
          startedAt: true,
          pipelineId: true,
          pipelineStatus: true,
          triggeredById: true,
          project: { select: { gitlabProjectId: true } },
        },
      });
      for (const run of runs) {
        try {
          await this.pollRun(run);
        } catch (e) {
          // Per-user GitLab problems (reconnect needed, 403/404, GitLab down) are retried on the next pass.
          if (!(e instanceof HttpException)) {
            this.logger.error(`Polling run ${run.id} failed: ${e instanceof Error ? e.stack : String(e)}`);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async pollRun(run: PolledRun): Promise<void> {
    if (Date.now() - run.startedAt.getTime() > this.cfg.runTimeoutMs) {
      await this.importer.close(run.id, 'Timed out waiting for GitLab');
      return;
    }
    const gitlabProjectId = run.project.gitlabProjectId;
    const userId = run.triggeredById;
    if (userId === null || gitlabProjectId === null || run.pipelineId === null) {
      await this.importer.close(run.id, 'The repository link or the triggering user was removed');
      return;
    }
    const pipelineId = run.pipelineId;
    const connection = await this.prisma.gitlabConnection.findUnique({ where: { userId }, select: { state: true } });
    if (connection?.state !== GitlabConnectionState.ACTIVE) return; // paused until the user reconnects

    const pipeline = await this.gitlab.withToken(userId, (token) => this.api.getPipeline(token, gitlabProjectId, pipelineId));
    if (!FINAL_PIPELINE_STATUSES.has(pipeline.status)) {
      if (pipeline.status !== run.pipelineStatus) {
        await this.prisma.testRun.update({ where: { id: run.id }, data: { pipelineStatus: pipeline.status }, select: { id: true } });
      }
      return;
    }
    await this.gitlab.withToken(userId, (token) => this.importer.importPipeline(token, run.id, pipeline));
  }
}
```

Replace `src/modules/automated-runs/automated-runs.module.ts` with:
```ts
import { Module } from '@nestjs/common';
import { AutomationModule } from '../automation/automation.module';
import { GitlabModule } from '../gitlab/gitlab.module';
import { RunsModule } from '../runs/runs.module';
import { AutomatedRunsController } from './automated-runs.controller';
import { AutomatedRunsService } from './automated-runs.service';
import { PipelinePollerService } from './pipeline-poller.service';
import { ResultImporterService } from './result-importer.service';

@Module({
  imports: [GitlabModule, AutomationModule, RunsModule],
  controllers: [AutomatedRunsController],
  providers: [AutomatedRunsService, ResultImporterService, PipelinePollerService],
})
export class AutomatedRunsModule {}
```

In `src/app.module.ts`, add `import { ScheduleModule } from '@nestjs/schedule';` and put `ScheduleModule.forRoot(),` in `imports` right after `ConfigModule.forRoot(…)`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx jest report-mapper && npm run test:e2e -- pipeline-import && npm run typecheck && npm test && npm run test:e2e`
Expected: 6 mapper tests and 6 `pipeline-import` e2e tests pass. Then unit `Tests: 95 passed`, and e2e `Tests: 118 passed, 118 total`, with no warnings and no open-handle message (the interval is off in `.env.test`, and the 20 s app in the last test is closed right away).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: poll GitLab pipelines and import test reports into automated runs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Create case from unlinked result, CI snippet, README and final verification

**Files:**
- Create: `src/modules/automation/ci-snippet.ts`, `src/modules/automation/ci-snippet.controller.ts`, `src/modules/automated-runs/dto/create-case-from-result.dto.ts`, `src/modules/automated-runs/unlinked-results.service.ts`
- Modify: `src/modules/automation/automation.module.ts`, `src/modules/automated-runs/automated-runs.controller.ts`, `src/modules/automated-runs/automated-runs.module.ts`, `test/gitlab-disabled.e2e-spec.ts` (one more test), `README.md`
- Test: `src/modules/automation/ci-snippet.spec.ts`, `test/automation-extras.e2e-spec.ts`

**Interfaces:**
- Consumes: `AutomationService.requireLinked` (Task 5); `TestCasesService.create(projectId, dto: CreateTestCaseDto, user)` (Phase 1, exported by `TestCasesModule`); `IsOptionalNonNull`; unlinked results from Task 8.
- Produces:
  - `DEFAULT_PLAYWRIGHT_CONFIG = 'playwright.config.ts'`, `ciSnippet(playwrightConfigPath?: string): string` (spec §7 job; adds `--config <path>` for a non-default config).
  - `GET /api/projects/:projectId/automation/ci-snippet` → `{ playwrightConfigPath, yaml }`.
  - `suggestCaseName(title: string | null): string | null`. `UnlinkedResultsService.createCase(runId, resultId, dto, user)`.
  - `POST /api/runs/:runId/results/:resultId/create-case` with `{ moduleId, name?, priority? }` → 201 `{ testCase, resultId, tag }`. The new case's notes name the source test; the result is linked to the new case even if the run is completed. Errors: 404 `Result not found in this run`; 409 `This result is already linked to a test case`; 400 `moduleId does not belong to this project`.

- [ ] **Step 1: Write the failing unit test**

`src/modules/automation/ci-snippet.spec.ts`:
```ts
import { ciSnippet } from './ci-snippet';

describe('ciSnippet', () => {
  it('matches the job from the spec for the default Playwright config', () => {
    expect(ciSnippet()).toBe(
      [
        'ejad-playwright:',
        "  image: mcr.microsoft.com/playwright:v1.47.0-jammy   # match the repo's @playwright/test version",
        '  rules:',
        "    - if: '$EJAD_RUN_ID'",
        '  script:',
        '    - npm ci',
        '    - npx playwright test ${EJAD_TEST_PATH} ${EJAD_TEST_GREP:+--grep "$EJAD_TEST_GREP"} --reporter=junit,html',
        '  variables:',
        '    PLAYWRIGHT_JUNIT_OUTPUT_NAME: results/junit.xml',
        '  artifacts:',
        '    when: always',
        '    expire_in: 14 days',
        '    reports:',
        '      junit: results/junit.xml',
        '    paths:',
        '      - results/',
        '      - playwright-report/',
        '      - test-results/',
        '',
      ].join('\n'),
    );
  });

  it('passes a custom Playwright config path', () => {
    expect(ciSnippet('e2e/playwright.config.ts')).toContain(
      '    - npx playwright test --config e2e/playwright.config.ts ${EJAD_TEST_PATH} ${EJAD_TEST_GREP:+--grep "$EJAD_TEST_GREP"} --reporter=junit,html',
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest ci-snippet`
Expected: FAIL with "Cannot find module './ci-snippet'".

- [ ] **Step 3: Implement the snippet**

`src/modules/automation/ci-snippet.ts`:
```ts
export const DEFAULT_PLAYWRIGHT_CONFIG = 'playwright.config.ts';

/**
 * The .gitlab-ci.yml job the tool's pipelines rely on. It only runs when EJAD_RUN_ID is set
 * (pipelines started from the tool) and publishes the JUnit report GitLab turns into test_report.
 */
export function ciSnippet(playwrightConfigPath: string = DEFAULT_PLAYWRIGHT_CONFIG): string {
  const config = playwrightConfigPath === DEFAULT_PLAYWRIGHT_CONFIG ? '' : ` --config ${playwrightConfigPath}`;
  return [
    'ejad-playwright:',
    "  image: mcr.microsoft.com/playwright:v1.47.0-jammy   # match the repo's @playwright/test version",
    '  rules:',
    "    - if: '$EJAD_RUN_ID'",
    '  script:',
    '    - npm ci',
    `    - npx playwright test${config} \${EJAD_TEST_PATH} \${EJAD_TEST_GREP:+--grep "$EJAD_TEST_GREP"} --reporter=junit,html`,
    '  variables:',
    '    PLAYWRIGHT_JUNIT_OUTPUT_NAME: results/junit.xml',
    '  artifacts:',
    '    when: always',
    '    expire_in: 14 days',
    '    reports:',
    '      junit: results/junit.xml',
    '    paths:',
    '      - results/',
    '      - playwright-report/',
    '      - test-results/',
    '',
  ].join('\n');
}
```

Run: `npx jest ci-snippet`
Expected: 2 tests pass.

- [ ] **Step 4: Write the failing e2e tests**

`test/automation-extras.e2e-spec.ts`:
```ts
import { RunStatus, RunType } from '@prisma/client';
import { ciSnippet } from '../src/modules/automation/ci-snippet';
import { FakeGitlab } from './utils/fake-gitlab';
import { seedActors, seedCase, seedModule, seedProject } from './utils/factories';
import { createGitlabTestApp, seedGitlabConnection, seedLinkedProject } from './utils/gitlab';
import { resetDb, TestContext } from './utils/test-app';

describe('Automation extras (e2e)', () => {
  let ctx: TestContext;
  let fake: FakeGitlab;
  let actors: Awaited<ReturnType<typeof seedActors>>;
  let projectId: string;
  let moduleId: string;
  let caseId: string;
  let runId: string;

  beforeAll(async () => {
    ({ ctx, fake } = await createGitlabTestApp());
  });
  beforeEach(async () => {
    await resetDb(ctx.prisma);
    fake.reset();
    actors = await seedActors(ctx);
    const { gitlabUser } = await seedGitlabConnection(ctx, fake, actors.tester.id, { username: 'tess' });
    projectId = (await seedLinkedProject(ctx, fake, actors.admin.id, [gitlabUser])).project.id;
    moduleId = (await seedModule(ctx.prisma, projectId)).id;
    caseId = (await seedCase(ctx.prisma, { projectId, moduleId, userId: actors.admin.id, code: 'TC-AUTH-001' })).id;
    runId = (
      await ctx.prisma.testRun.create({
        data: {
          projectId,
          name: 'Automated · main',
          type: RunType.AUTOMATED,
          status: RunStatus.COMPLETED,
          completedAt: new Date(),
          branch: 'main',
          createdById: actors.tester.id,
          triggeredById: actors.tester.id,
        },
      })
    ).id;
  });
  afterAll(async () => {
    await ctx.app.close();
    await fake.close();
  });

  const unlinked = (title: string, file: string | null = 'e2e/cart/cart.spec.ts') =>
    ctx.prisma.testResult.create({ data: { runId, title, file, status: 'PASSED' } });
  const createCase = (resultId: string, body: Record<string, unknown>, run = runId) =>
    ctx.http().post(`/api/runs/${run}/results/${resultId}/create-case`).set(actors.testerAuth).send(body);

  it('returns the CI job snippet for the project', async () => {
    const res = await ctx.http().get(`/api/projects/${projectId}/automation/ci-snippet`).set(actors.testerAuth).expect(200);
    expect(res.body).toEqual({ playwrightConfigPath: 'playwright.config.ts', yaml: ciSnippet() });
    expect(res.body.yaml).toContain("- if: '$EJAD_RUN_ID'");
  });

  it('creates a test case from an unlinked result and links the result to it', async () => {
    const result = await unlinked('cart/cart.spec.ts › adds an item to the cart');
    const res = await createCase(result.id, { moduleId }).expect(201);
    expect(res.body).toMatchObject({
      resultId: result.id,
      tag: '@TC-AUTH-002',
      testCase: {
        code: 'TC-AUTH-002',
        name: 'adds an item to the cart',
        notes: 'Created from automated test "cart/cart.spec.ts › adds an item to the cart" in e2e/cart/cart.spec.ts',
        module: { code: 'AUTH' },
        createdBy: { id: actors.tester.id, name: 'Tess Tester' },
      },
    });
    expect((await ctx.prisma.testResult.findUniqueOrThrow({ where: { id: result.id } })).testCaseId).toBe(res.body.testCase.id);

    const tagged = await unlinked('legacy › old checkout @TC-OLD-001', null);
    const custom = await createCase(tagged.id, { moduleId, name: 'Checkout works', priority: 'HIGH' }).expect(201);
    expect(custom.body.testCase).toMatchObject({ code: 'TC-AUTH-003', name: 'Checkout works', priority: 'HIGH', notes: 'Created from automated test "legacy › old checkout @TC-OLD-001"' });
  });

  it('refuses linked results, results of other runs and modules of other projects', async () => {
    const linked = await ctx.prisma.testResult.create({ data: { runId, testCaseId: caseId, status: 'PASSED' } });
    const already = await createCase(linked.id, { moduleId }).expect(409);
    expect(already.body.message).toBe('This result is already linked to a test case');

    const result = await unlinked('cart › adds an item');
    const foreignRun = await createCase(result.id, { moduleId }, '7a1d0c5e-0000-4000-8000-000000000000').expect(404);
    expect(foreignRun.body.message).toBe('Result not found in this run');

    const other = await seedProject(ctx.prisma, actors.admin.id, { key: 'OTHER' });
    const otherModule = await seedModule(ctx.prisma, other.id, { code: 'PAY', name: 'Payments' });
    const wrongModule = await createCase(result.id, { moduleId: otherModule.id }).expect(400);
    expect(wrongModule.body.message).toBe('moduleId does not belong to this project');
    expect((await ctx.prisma.testResult.findUniqueOrThrow({ where: { id: result.id } })).testCaseId).toBeNull();
  });
});
```

Add this test at the end of the `describe` in `test/gitlab-disabled.e2e-spec.ts`:
```ts
  it('hides the CI snippet and create-case endpoints', async () => {
    const project = await seedProject(ctx.prisma, actors.admin.id, { key: 'SNIP' });
    await expectHidden('get', `/api/projects/${project.id}/automation/ci-snippet`);
    await expectHidden(
      'post',
      '/api/runs/7a1d0c5e-0000-4000-8000-000000000000/results/7a1d0c5e-0000-4000-8000-000000000001/create-case',
      { moduleId: '7a1d0c5e-0000-4000-8000-000000000002' },
    );
  });
```

- [ ] **Step 5: Run them to verify they fail**

Run: `npm run test:e2e -- automation-extras gitlab-disabled`
Expected: FAIL (404 "Cannot GET …/automation/ci-snippet" and "Cannot POST …/create-case").

- [ ] **Step 6: Implement the snippet endpoint and create-case**

`src/modules/automation/ci-snippet.controller.ts`:
```ts
import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { GitlabEnabledGuard } from '../gitlab/gitlab-enabled.guard';
import { AutomationService } from './automation.service';
import { ciSnippet } from './ci-snippet';

@ApiTags('Automation')
@ApiBearerAuth()
@UseGuards(GitlabEnabledGuard)
@Controller('projects/:projectId/automation')
export class CiSnippetController {
  constructor(private readonly automation: AutomationService) {}

  @Get('ci-snippet')
  async get(@Param('projectId', ParseUUIDPipe) projectId: string) {
    const project = await this.automation.requireLinked(projectId);
    return { playwrightConfigPath: project.playwrightConfigPath, yaml: ciSnippet(project.playwrightConfigPath) };
  }
}
```

Replace `src/modules/automation/automation.module.ts` with:
```ts
import { Module } from '@nestjs/common';
import { GitlabModule } from '../gitlab/gitlab.module';
import { ProjectsModule } from '../projects/projects.module';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';
import { CiSnippetController } from './ci-snippet.controller';
import { CoverageCache } from './coverage-cache';
import { CoverageController } from './coverage.controller';
import { CoverageService } from './coverage.service';
import { RepositoryController } from './repository.controller';
import { RepositoryService } from './repository.service';

@Module({
  imports: [GitlabModule, ProjectsModule],
  controllers: [RepositoryController, AutomationController, CoverageController, CiSnippetController],
  providers: [RepositoryService, AutomationService, CoverageService, CoverageCache],
  exports: [AutomationService],
})
export class AutomationModule {}
```

`src/modules/automated-runs/dto/create-case-from-result.dto.ts`:
```ts
import { Priority } from '@prisma/client';
import { IsEnum, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../../common/decorators/is-optional-non-null.decorator';

export class CreateCaseFromResultDto {
  @IsUUID()
  moduleId!: string;

  /** Defaults to the test title without the file/describe path and tags. */
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  name?: string;

  @IsOptionalNonNull()
  @IsEnum(Priority)
  priority?: Priority;
}
```

`src/modules/automated-runs/unlinked-results.service.ts`:
```ts
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { TestCasesService } from '../test-cases/test-cases.service';
import { CreateCaseFromResultDto } from './dto/create-case-from-result.dto';

const ALREADY_LINKED = 'This result is already linked to a test case';

/** "cart/cart.spec.ts › Cart › adds an item @smoke" → "adds an item". */
export function suggestCaseName(title: string | null): string | null {
  if (!title) return null;
  const last = title.split(' › ').pop() ?? title;
  const name = last.replace(/@\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return name || null;
}

@Injectable()
export class UnlinkedResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly testCases: TestCasesService,
  ) {}

  /** Turns an unlinked automated result into a new test case (same rules as the web form) and links it. */
  async createCase(runId: string, resultId: string, dto: CreateCaseFromResultDto, user: AuthUser) {
    const result = await this.prisma.testResult.findFirst({
      where: { id: resultId, runId },
      include: { run: { select: { projectId: true } } },
    });
    if (!result) throw new NotFoundException('Result not found in this run');
    if (result.testCaseId) throw new ConflictException(ALREADY_LINKED);

    const name = dto.name ?? suggestCaseName(result.title);
    if (!name) throw new BadRequestException('name is required for results without a title');
    const notes = result.title ? `Created from automated test "${result.title}"${result.file ? ` in ${result.file}` : ''}` : undefined;
    const testCase = await this.testCases.create(result.run.projectId, { moduleId: dto.moduleId, name, priority: dto.priority, notes }, user);

    // Link only if nobody linked it meanwhile; otherwise retire the case we just created.
    const linked = await this.prisma.testResult.updateMany({ where: { id: resultId, testCaseId: null }, data: { testCaseId: testCase.id } });
    if (linked.count !== 1) {
      await this.prisma.testCase.update({ where: { id: testCase.id }, data: { deletedAt: new Date() }, select: { id: true } });
      throw new ConflictException(ALREADY_LINKED);
    }
    return { testCase, resultId, tag: `@${testCase.code}` };
  }
}
```

Replace `src/modules/automated-runs/automated-runs.controller.ts` with:
```ts
import { Body, Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthUser } from '../../common/types/auth-user';
import { GitlabEnabledGuard } from '../gitlab/gitlab-enabled.guard';
import { AutomatedRunsService } from './automated-runs.service';
import { CreateAutomatedRunDto } from './dto/create-automated-run.dto';
import { CreateCaseFromResultDto } from './dto/create-case-from-result.dto';
import { UnlinkedResultsService } from './unlinked-results.service';

@ApiTags('Automation')
@ApiBearerAuth()
@UseGuards(GitlabEnabledGuard)
@Controller()
export class AutomatedRunsController {
  constructor(
    private readonly automatedRuns: AutomatedRunsService,
    private readonly unlinked: UnlinkedResultsService,
  ) {}

  @Post('projects/:projectId/runs/automated')
  trigger(@Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: CreateAutomatedRunDto, @CurrentUser() user: AuthUser) {
    return this.automatedRuns.trigger(projectId, dto, user);
  }

  @Post('runs/:runId/results/:resultId/create-case')
  createCase(
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('resultId', ParseUUIDPipe) resultId: string,
    @Body() dto: CreateCaseFromResultDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.unlinked.createCase(runId, resultId, dto, user);
  }
}
```

Replace `src/modules/automated-runs/automated-runs.module.ts` with:
```ts
import { Module } from '@nestjs/common';
import { AutomationModule } from '../automation/automation.module';
import { GitlabModule } from '../gitlab/gitlab.module';
import { RunsModule } from '../runs/runs.module';
import { TestCasesModule } from '../test-cases/test-cases.module';
import { AutomatedRunsController } from './automated-runs.controller';
import { AutomatedRunsService } from './automated-runs.service';
import { PipelinePollerService } from './pipeline-poller.service';
import { ResultImporterService } from './result-importer.service';
import { UnlinkedResultsService } from './unlinked-results.service';

@Module({
  imports: [GitlabModule, AutomationModule, RunsModule, TestCasesModule],
  controllers: [AutomatedRunsController],
  providers: [AutomatedRunsService, ResultImporterService, PipelinePollerService, UnlinkedResultsService],
})
export class AutomatedRunsModule {}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run test:e2e -- automation-extras gitlab-disabled`
Expected: `automation-extras` 3 and `gitlab-disabled` 6 tests pass.

- [ ] **Step 8: Add the "GitLab setup" section to the README**

In `README.md`, change the intro's first sentence to end with `…Excel/CSV import and export, reports, and GitLab test automation (Phase 2).` Then append this section at the end of the file:

````markdown
## GitLab setup (test automation)

The tool links each project to its GitLab repository. Testers edit Playwright tests in the browser (saves go to
a `tests/<gitlab-username>-<work-name>` branch with a merge request) and start runs as GitLab CI pipelines. The
results come back as **Automated** runs. The API server never runs repository code: tests run on your GitLab runners.
When `GITLAB_URL` is empty, all of this is switched off (the endpoints answer 404).

### 1. Register the OAuth application (once, GitLab admin)

In GitLab (**Admin Area → Applications → New application**, or a group-owned application):

- **Name:** Ejad Test Cases
- **Redirect URI:** `https://<api-host>/api/gitlab/oauth/callback`
- **Confidential:** yes. **Scopes:** `api` (needed for commits, merge requests and pipelines).

Copy the Application ID and Secret into the API environment.

### 2. API environment

| Variable | Example |
|---|---|
| `GITLAB_URL` | `https://git.ejad.net` (leave empty to disable GitLab features) |
| `GITLAB_OAUTH_CLIENT_ID`, `GITLAB_OAUTH_CLIENT_SECRET` | from step 1 |
| `GITLAB_OAUTH_REDIRECT_URI` | `https://<api-host>/api/gitlab/oauth/callback` (must match step 1) |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `WEB_URL` | `https://<web-host>` – where the browser goes after connecting GitLab |
| `GITLAB_POLL_INTERVAL_MS` | `20000` (default) – how often running pipelines are checked |
| `GITLAB_RUN_TIMEOUT_MINUTES` | `120` (default) – unfinished automated runs are closed after this |

GitLab tokens are stored AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY`. If you change the key, every user has
to reconnect GitLab. The poller and token refresh run inside the API process, so keep a **single** API container.

### 3. Runners

The project needs a GitLab Runner with the **Docker** executor (a shared, group or project runner). The job uses
the official Playwright image. Pick the tag that matches the repository's `@playwright/test` version, e.g.
`mcr.microsoft.com/playwright:v1.47.0-jammy`.

### 4. CI job

Add this job to the repository's `.gitlab-ci.yml`. The Automation tab shows the same snippet (with the project's
Playwright config path) and has a copy button:

```yaml
ejad-playwright:
  image: mcr.microsoft.com/playwright:v1.47.0-jammy   # match the repo's @playwright/test version
  rules:
    - if: '$EJAD_RUN_ID'
  script:
    - npm ci
    - npx playwright test ${EJAD_TEST_PATH} ${EJAD_TEST_GREP:+--grep "$EJAD_TEST_GREP"} --reporter=junit,html
  variables:
    PLAYWRIGHT_JUNIT_OUTPUT_NAME: results/junit.xml
  artifacts:
    when: always
    expire_in: 14 days
    reports:
      junit: results/junit.xml
    paths:
      - results/
      - playwright-report/
      - test-results/
```

Pipelines started from the tool set `EJAD_RUN_ID`, and `EJAD_TEST_PATH` / `EJAD_TEST_GREP` for a folder/file or
selected cases. Other jobs in the file also run in these pipelines unless their `rules` skip `$EJAD_RUN_ID`.

### 5. Linking tests to test cases

Put the case ID as a tag in the Playwright test title, e.g. `test('logs in @TC-AUTH-001', …)` or
`test('logs in', { tag: '@TC-AUTH-001' }, …)`. When the pipeline finishes, each tagged test fills that case's result:
passed → Passed, failed/error → Failed, skipped → Skipped. If a case has several tests, it is Failed if any of
them failed. Untagged tests show up as **Unlinked** results with "Create test case from this". Failed results link
to the job's artifacts (`/-/jobs/<id>/artifacts/browse`, which also holds the Playwright HTML report).

### 6. Connecting and linking

Each tester connects their own GitLab account under **Profile → GitLab**, and every GitLab action uses that
person's permissions. An admin links a project under **Settings → Repository** (GitLab project, default branch,
tests folder, Playwright config path).
````

- [ ] **Step 9: Final verification**

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
npm run start:prod &
sleep 5
curl -s http://localhost:3000/api/health
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"email":"admin@ejad.local","password":"ChangeMe123!"}' | node -pe "JSON.parse(require('fs').readFileSync(0)).accessToken")
curl -s http://localhost:3000/api/gitlab/status -H "Authorization: Bearer $TOKEN"
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/gitlab/oauth/start -H "Authorization: Bearer $TOKEN"
kill %1
```
Expected: typecheck and build succeed. Unit `Tests: 97 passed, 97 total`, and e2e `Tests: 122 passed, 122 total`, with no warnings. Health prints `{"status":"ok"}`. With `GITLAB_URL` unset in `.env`, status prints `{"enabled":false,"connection":null}` and `oauth/start` prints `404`. If port 3000 is taken by a running dev server, set `PORT=3100` for the smoke run and adjust the URLs.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: create cases from unlinked results, CI snippet and GitLab setup docs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Next plans (not part of this plan)

1. **Web Phase 2** (`ejad-testcases-web`): Profile GitLab card, Settings → Repository, Automation tab (tree, Monaco editor, save flow, coverage, CI snippet), Run tests dialog and automated run views. GitLab spec §10 and §13 steps 4–5.
2. **MCP AI test authoring**: `docs/superpowers/specs/2026-09-18-mcp-ai-test-authoring-design.md`.
