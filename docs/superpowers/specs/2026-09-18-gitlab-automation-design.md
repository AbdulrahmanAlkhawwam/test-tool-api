# Ejad Test Case Tool — GitLab Test Automation (Phase 2) Design Spec

- **Date:** 2026-09-18
- **Status:** Approved in brainstorming, pending written-spec review
- **Supersedes:** §11 "Phase 2 — Automation" (local runner) of `2026-09-18-ejad-test-case-tool-design.md`
- **Order:** Phase 1 merge → **this (Phase 2)** → MCP AI test authoring (`2026-09-18-mcp-ai-test-authoring-design.md`)

## 1. Purpose

Connect each project in the tool to its repository on the company GitLab (**https://git.ejad.net**, self-hosted
GitLab with Docker runners), so that testers can:

1. See the project's **automated test folder** (Playwright) inside the tool.
2. **Edit test files** in the browser; saving creates commits on a work branch and a **merge request**.
3. **Run** the tests in **GitLab CI** from the tool and get the results back as an **Automated run**,
   linked to the test cases through `@TC-…` tags.

Success criteria:

1. A tester connects their GitLab account once; an admin links a project to a GitLab repo + tests folder.
2. The Automation tab shows the tests folder tree, opens files in a code editor, and "Save" produces a
   commit on `tests/<username>-<slug>` plus an open merge request (link shown).
3. "Run tests" starts a pipeline as the tester; the run page shows pipeline status; when it finishes, each
   `@TC-AUTH-001`-tagged test fills that case's result (Passed/Failed/Skipped, error, duration) with links to
   GitLab artifacts; untagged tests appear as Unlinked.
4. The tool's server never executes repository code.

## 2. Scope

**In:** GitLab OAuth per user, repository link per project, Automation tab (tree, editor, save → branch +
MR, coverage by tags), pipeline trigger with scope, result import from GitLab's test report, provided
`.gitlab-ci.yml` job, artifact links, unlinked results + "create case from this".
**Out:** other Git providers, running tests on the tool server or testers' machines (old local runner is
dropped), storing screenshots in the tool (GitLab artifacts are linked instead), merging MRs from the tool.

## 3. Configuration (API env)

```
GITLAB_URL=https://git.ejad.net
GITLAB_OAUTH_CLIENT_ID=…            # OAuth application registered once by a GitLab admin
GITLAB_OAUTH_CLIENT_SECRET=…
GITLAB_OAUTH_REDIRECT_URI=https://<api-host>/api/gitlab/oauth/callback
TOKEN_ENCRYPTION_KEY=<32-byte base64> # AES-256-GCM for stored GitLab tokens
WEB_URL=https://<web-host>           # where the OAuth callback returns the browser
```
OAuth application scopes: `api` (needed for commits, merge requests and pipelines). If `GITLAB_URL` is not
set, all GitLab features are hidden and their endpoints return 404.

## 4. GitLab connection (per user)

- **Profile → GitLab → Connect** starts OAuth authorization code flow with **PKCE** and a signed,
  single-use `state` (10-minute expiry, bound to the user). Callback exchanges the code, stores the access
  and refresh tokens **encrypted** (AES-256-GCM, random IV) with GitLab user id/username/avatar, and
  redirects to `WEB_URL/profile?gitlab=connected`.
- Tokens are refreshed automatically when expired (GitLab tokens expire after 2 h); a failed refresh marks
  the connection **needs reconnect** and the UI asks the user to reconnect.
- **Disconnect** revokes the token at GitLab (best effort) and deletes it.
- All GitLab calls for a request are made **with the current user's token**; if they aren't connected,
  GitLab features show "Connect GitLab to use automation".

## 5. Repository link (per project)

Project **Settings → Repository** (admins): search GitLab projects the admin can access
(`GET /projects?search=&membership=true`), then store:
`gitlabProjectId`, `gitlabPath` (e.g. `mobile/ninja-store`), `gitlabWebUrl`, `defaultBranch`,
`testsPath` (e.g. `e2e`), `playwrightConfigPath` (default `playwright.config.ts`).
The project header shows a repository link. Unlinking clears these fields (runs keep their history).

## 6. Automation tab (web)

- **File tree** of `testsPath` on the selected branch (default branch, or the user's work branch if it
  exists): `GET /repository/tree?path&ref&recursive=true` (paginated).
- **Editor:** Monaco editor (`@monaco-editor/react`), TypeScript/JavaScript highlighting; read via
  `GET /repository/files/:path/raw?ref`. Files > 1 MB open read-only.
- **Save:** commits the changed file(s) with `POST /repository/commits` to the user's work branch
  `tests/<gitlab-username>-<slug>` (slug from a short name the user gives on first save, e.g. "login
  fixes"); the branch is created from `defaultBranch` on first save (`start_branch`). Then opens or updates
  one merge request per work branch (`POST/PUT /merge_requests`, target = defaultBranch, title from the
  slug, description lists edited files and linked case codes). The tab shows the MR link and state.
  Conflicts (file changed on the branch since it was opened — detected via `last_commit_id`) → 409 with
  "This file changed on the branch – reload it before saving".
- **New file:** create inside `testsPath` only (path validated: no `..`, must end in `.spec.ts`/`.test.ts`/
  `.ts`/`.js`).
- **Coverage:** the tool scans test titles for `@TC-<CODE>` tags (regex over file contents of the tree,
  cached per commit SHA) and shows, per file, the cases it covers, plus **"Not automated yet"**: approved
  cases with no tag anywhere in the folder.
- **Write rules:** paths outside `testsPath` are rejected server-side; the tool never commits to
  `defaultBranch` directly.

## 7. Running tests in GitLab CI

- **"Run tests"** (Automation tab or Runs tab): choose **branch** (default or a work branch) and **scope**:
  all / a folder / a file / selected cases (by code). The API:
  1. creates a `TestRun` (`type = AUTOMATED`, `status = IN_PROGRESS`, `branch`, `triggeredById`);
  2. triggers `POST /projects/:id/pipeline` as the user with variables
     `EJAD_RUN_ID=<run id>`, `EJAD_TEST_PATH=<folder or file, optional>`, `EJAD_TEST_GREP=<@TC-A|@TC-B, optional>`;
  3. stores `pipelineId`, `pipelineWebUrl`.
  A pipeline that can't be created (no `.gitlab-ci.yml` job, permissions) → the run is closed immediately
  with the GitLab error message.
- **Provided CI job** (shown with a copy button in the Automation tab; also in the README):

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

- **Result import:** a scheduled job in the API (every 20 s) polls pipelines of IN_PROGRESS automated
  runs (`GET /pipelines/:id`, as the triggering user; paused if their connection needs reconnect) and the
  run page shows `pending / running / success / failed / canceled`. When the pipeline reaches a final
  state, the API reads `GET /pipelines/:id/test_report` and maps each test case:
  - name contains `@TC-<CODE>` of a non-deleted case in the project → that case's result:
    `success → PASSED`, `failed/error → FAILED`, `skipped → SKIPPED`; `errorMessage` = system_output/failure
    message (truncated 10 000 chars); `durationMs`; `executedAt` = pipeline finished_at; `executedById` =
    triggering user. A case matched by several tests: FAILED if any failed, else PASSED if any passed.
  - no tag / unknown code → **Unlinked** result (`testCaseId = null`, `title` = test name, file) with a
    "Create test case from this" action (pre-fills name/module).
  - Selected cases in scope with no matching test → NOT_EXECUTED with note "No automated test found".
  Then the run is marked `COMPLETED`. Pipelines that end without a test report → run completed with note
  "Pipeline finished without a test report" + job link. Runs still pending after 2 h → completed with
  note "Timed out waiting for GitLab".
- **Artifacts:** each failed result links to the job's artifacts browser
  (`<gitlabWebUrl>/-/jobs/<jobId>/artifacts/browse`) and the Playwright HTML report; nothing is copied into
  the tool.
- Manual edits to automated runs follow the normal rules (results editable until the run is completed —
  automated runs are completed by the importer, so they're read-only; a tester can re-run instead).

## 8. Data model changes

```
enum GitlabConnectionState { ACTIVE NEEDS_RECONNECT }

GitlabConnection  id, userId @unique, gitlabUserId, username, avatarUrl?,
                  accessTokenEnc, refreshTokenEnc, expiresAt, state GitlabConnectionState,
                  createdAt, updatedAt

GitlabOAuthState  id, userId, stateHash @unique, codeVerifierEnc, expiresAt, usedAt?   -- short-lived

Project        + gitlabProjectId Int?, gitlabPath String?, gitlabWebUrl String?, defaultBranch String?,
                 testsPath String?, playwrightConfigPath String?

TestRun        + branch String?, pipelineId Int?, pipelineWebUrl String?, pipelineStatus String?,
                 triggeredById String?, note String?

TestResult     + file String?, artifactsUrl String?        -- (title, durationMs, errorMessage exist)
```
Migration is additive. The unused Phase-2 placeholders from the Phase 1 spec (RunnerToken, RunnerPath,
Attachment) are **not** created.

## 9. API endpoints

```
GET    /api/gitlab/status                       { enabled, connection: { username, state } | null }
GET    /api/gitlab/oauth/start                  → { authorizeUrl }
GET    /api/gitlab/oauth/callback               (public; state-verified) → redirect to WEB_URL
DELETE /api/gitlab/connection
GET    /api/gitlab/projects?search=             (admin; for linking)
PUT    /api/projects/:id/repository             (admin) { gitlabProjectId, defaultBranch, testsPath, playwrightConfigPath }
DELETE /api/projects/:id/repository             (admin)
GET    /api/projects/:id/automation/branches    default + the user's work branches (+ MR state)
GET    /api/projects/:id/automation/tree?ref=
GET    /api/projects/:id/automation/file?ref=&path=     → { content, lastCommitId, size }
PUT    /api/projects/:id/automation/file        { path, content, lastCommitId?, branchSlug } → { branch, commitId, mergeRequest }
GET    /api/projects/:id/automation/coverage?ref=
POST   /api/projects/:id/runs/automated         { branch, scope: { mode: ALL|PATH|CASES, path?, caseIds? } } → run
GET    /api/projects/:id/automation/ci-snippet  → the YAML above
POST   /api/runs/:runId/results/:resultId/create-case   (unlinked → new test case, pre-filled) 
```
Rate limiting: GitLab calls are proxied per user; GitLab's own limits apply. A GitLab 401 marks the
connection NEEDS_RECONNECT; 403/404 are returned to the UI with GitLab's message.

## 10. Web changes

- Profile: **GitLab** card (Connect / Reconnect / Disconnect, username + avatar).
- Project Settings → **Repository** (admins): GitLab project search, default branch, tests folder,
  Playwright config path; shows the repo link.
- Project header: repository link when linked.
- New **Automation** tab (visible when linked): branch selector, file tree, Monaco editor with Save
  (asks for a short work name on first save), MR link/state, coverage panel, "Not automated yet" list,
  **Run tests** dialog (branch + scope), CI snippet with copy button.
- Runs list/detail: automated runs show branch, pipeline status badge + link, note; failed results link
  to artifacts; Unlinked results show "Create test case from this".

## 11. Security

- The tool never runs repository code; CI runs on GitLab runners.
- OAuth with PKCE + single-use hashed state; GitLab tokens AES-256-GCM encrypted at rest; key from env.
- All GitLab actions use the acting user's own token → GitLab permissions apply per person.
- Server-side path validation keeps edits inside `testsPath`; never commits to the default branch.
- Only admins link/unlink repositories.

## 12. Testing

- **Unit:** token encryption round-trip; JUnit/test-report → results mapping (tags, multiple tests per
  case, unknown tags, skipped/error); work-branch slug; path validation; CI snippet.
- **API e2e:** a **fake GitLab server** (small Express app started by the test harness on a random port,
  `GITLAB_URL` pointing at it) implementing the endpoints used: OAuth token exchange, projects search,
  tree/file/commits, merge requests, pipeline create/get/test_report. Covers: connect flow (state/PKCE,
  encrypted storage), link repo (admin only), tree/file read, save → branch created + MR opened,
  stale `lastCommitId` → 409, path outside testsPath → 400, run automated → pipeline created with
  variables, importer maps results + unlinked + completes the run, pipeline without report → note,
  expired token refresh, 401 → NEEDS_RECONNECT.
- **Web:** component tests for the save flow (first-save work name, MR link), run status panel, coverage
  list; Playwright step against the fake GitLab (optional, if the harness can run it).

## 13. Delivery order

1. API: schema/migration, encryption util, GitLab client + OAuth connection.
2. API: repository link, tree/file/save (branch + MR), coverage.
3. API: automated run trigger, pipeline poller + result importer, create-case-from-unlinked.
4. Web: Profile GitLab card, Settings → Repository, Automation tab (tree, editor, save, coverage).
5. Web: Run tests dialog, automated run views, CI snippet.
6. Docs: README "GitLab setup" (OAuth app registration, runner image, CI job).
