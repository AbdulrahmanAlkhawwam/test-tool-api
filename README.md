# Ejad Test Cases API

The backend for Ejad's test case tool: projects, modules, manual test cases, test runs with
instant-save results, Excel/CSV import and export, reports, GitLab test automation (Phase 2) and a
hosted MCP server so AI assistants can write test cases and Playwright tests. NestJS 10, Prisma 7, PostgreSQL 16.

The design spec and plans are in `docs/superpowers/`.

## Local development

```bash
cp .env.example .env
npm install
npm run db:up            # PostgreSQL via Docker: both dev and test databases on port 5442
npx prisma migrate dev
npm run db:seed          # creates SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
npm run start:dev        # http://localhost:3000/api — Swagger at /api/docs
```

### Native PostgreSQL alternative

If Docker isn't available, install PostgreSQL 16 to listen on port 5442 and create the two
databases with `psql`:

```bash
psql -h localhost -p 5442 -U postgres -c "CREATE DATABASE ejad_testcases;"
psql -h localhost -p 5442 -U postgres -c "CREATE DATABASE ejad_testcases_test;"
```

Then continue from `npx prisma migrate dev` above.

## Tests

```bash
npm test                 # unit tests
npm run test:e2e         # e2e tests against the test database (port 5442)
```

## Connect your AI (MCP)

The API hosts an MCP server at **`POST /api/mcp`** so Claude Code, Claude Desktop, Cursor or any
other MCP client can read and write test cases. Everything an AI writes is a **draft** until a
tester approves it in the web app. No environment variable configures this — the token format, the
rate limits and the batch/page caps are constants in the source.

### 1. Create a personal access token

In the web app, **Profile → AI access**: give the token a name, pick an expiry (30, 90 or 180 days;
90 by default) and copy the value — it is shown **once**. The token looks like
`ejad_pat_<32 characters>`. Only its SHA-256 hash and the first 8 characters of the random part are
stored, so a lost token cannot be recovered; revoke it and make a new one.

A token acts as you, with your role. Revoking it, letting it expire, or deactivating the account
stops it working immediately (the next request gets `401 Invalid or expired access token` — the
same message for an unknown, revoked, expired or inactive token, so a caller can never tell which).

### 2. Point your client at the endpoint

Claude Code:

```bash
claude mcp add --transport http ejad-tests https://<api-host>/api/mcp --header "Authorization: Bearer ejad_pat_…"
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ejad-tests": {
      "url": "https://<api-host>/api/mcp",
      "headers": { "Authorization": "Bearer ejad_pat_…" }
    }
  }
}
```

Cursor (`.cursor/mcp.json`): the same `url` and `headers` shape as Claude Desktop above.

The endpoint speaks MCP **Streamable HTTP** in stateless mode: every request gets a fresh server and
transport, there is no session store, and `GET`/`DELETE` (used by stateful servers for an SSE stream
and session teardown) both answer `405` with `Allow: POST`. The token is the **only** accepted
credential: browser JWTs are rejected on `/api/mcp`, and a personal access token is rejected on
every other route (the global JWT guard can't verify it). `/api/mcp` reads no cookies, so no CSRF
handling applies to it.

Two rate limits apply, both returning the same `429` body
(`{ statusCode: 429, error: 'Too Many Requests', message: 'Too many MCP requests, please slow down' }`):
**120 requests per minute per token**, and an IP-keyed **300 requests per minute** that runs ahead of
authentication so a flood of bad tokens from one address can't dodge the per-token limit. Both
limiters live in memory, which is one more reason to run a **single** API container.

### 3. What the AI can and cannot do

Nine tools:

| Tool | Description |
|---|---|
| `list_projects` | Projects in the tool, with approved case counts and the latest test run. |
| `get_project` | One project with its modules and each module's approved case count. |
| `list_test_cases` | Test cases in a project (AI drafts included by default). |
| `get_test_case` | Every template field of one case, its review state, any pending suggestion and its last 10 results. |
| `get_failing_cases` | Cases whose most recent executed result is Failed, with the actual result and the run it came from. |
| `get_test_cases_for_automation` | Approved cases as an automation spec, in code order — the input to Playwright test generation. |
| `create_module` | Adds a module (feature area) to a project; the code is derived from the name when omitted. |
| `create_test_cases` | Creates up to 50 cases as AI drafts, each validated on its own. |
| `update_test_case` | Changes template fields of one case (direct on a draft, a suggestion on an approved case). |

One prompt: `write_playwright_tests` — turns a project's approved test cases into Playwright tests
tagged with their case codes.

- **New cases** are created as **AI drafts** (`TC-<MODULE>-NNN`, up to 50 per call). Drafts are
  excluded from runs, reports, the dashboard, project and module case counts, exports and
  automation coverage until a tester approves them; the Test Cases tab lists them under
  "AI drafts". Rejecting a draft is the same `DELETE /api/test-cases/:id` a tester uses on any
  case — it soft-deletes the draft, and its ID is never reused.
- **Edits to a draft** are applied directly. **Edits to an approved case** become a pending
  suggestion (one per case, the newest replaces the previous) that a tester accepts or rejects
  field by field. Accepting is refused with `409` if a human changed one of the same fields
  meanwhile.
- The AI **cannot** delete a case, approve a draft, accept a suggestion, create or complete a run,
  or record results. Those are people's decisions and live in the web app only.

**A malformed call is rejected before it reaches the tool.** `create_test_cases` with more than 50
cases, or `update_test_case` with a field over its length limit, fails MCP's own schema validation:
the client sees a JSON-RPC `InvalidParams` error, not a normal tool result with `isError: true`.
This is deliberate — those two shapes are structurally invalid, unlike an item inside a valid-sized
`create_test_cases` batch (a bad module code, an empty name, …), which the batch's own per-item
validation reports individually so the rest of the batch still gets created.

### 4. Playwright tests

Ask for the `write_playwright_tests` prompt (or just ask in words). The AI calls
`get_test_cases_for_automation` — approved cases only — and writes one `test()` per case titled
`'<name> @<code>'`. That `@TC-…` tag is what the GitLab result import matches back to the case, so
the same run that executes the tests fills in the case results (see **Linking tests to test cases**
above).

## Deploy (Dokploy)

Build the `Dockerfile`. On start, the container applies migrations, seeds the first admin (only if it
doesn't exist yet) and starts the API on port 3000. The container runs as the unprivileged `node` user
and shuts down gracefully on SIGTERM.

| Variable | Example |
|---|---|
| `DATABASE_URL` | `postgresql://user:pass@postgres:5432/ejad_testcases` |
| `PORT` | `3000` (default) |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | long random strings |
| `CORS_ORIGIN` | `https://tests.ejad.example` (comma-separated for several) |
| `COOKIE_SECURE` | `true` behind HTTPS |
| `COOKIE_SAMESITE` | `lax` if web and API share a site, `none` if they are on different sites (`none` requires `COOKIE_SECURE=true`, otherwise browsers drop the cookie) |
| `JWT_ACCESS_TTL` | `15m` (default) – access token lifetime |
| `JWT_REFRESH_TTL_DAYS` | `7` (default) – refresh cookie lifetime in days |
| `LOGIN_RATE_LIMIT` | `10` (default) – login attempts per minute per client IP |
| `BCRYPT_ROUNDS` | `10` (default) – password hashing cost |
| `TRUST_PROXY` | `1` behind Dokploy/Traefik (proxy hops to trust, or `true`/`false`); unset = don't trust proxies. Without it every user shares the proxy's IP and one login rate-limit bucket |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME` | first admin account |

Import previews are held in memory for 30 minutes, so run a **single** API container. GitLab test
automation (see below) needs a single API container too, so this holds regardless.

## GitLab setup (test automation)

The tool links each project to its GitLab repository. Testers edit Playwright tests in the browser (saves
go to a `tests/<gitlab-username>/<slug>` branch with a merge request) and start runs as GitLab CI
pipelines. The results come back as **Automated** runs. The API server never runs repository code: tests
run on your GitLab runners. When `GITLAB_URL` is empty, all of this is switched off (every GitLab and
automation endpoint answers 404, and `GET /api/gitlab/status` returns `{ enabled: false, connection: null }`).

### 1. Register the OAuth application (once, GitLab admin)

In GitLab (**Admin Area → Applications → New application**, or a group-owned application):

- **Name:** Ejad Test Cases
- **Redirect URI:** `<web app URL>/gitlab/callback` — the **web** app, not the API. GitLab redirects the
  browser here after the user authorizes; the web page then calls the authenticated
  `POST /api/gitlab/oauth/complete` with the returned `code`/`state`, which binds the new tokens to
  whichever user is signed in on that browser. There is no public API-side OAuth callback — a stateless
  API callback could let one user's authorization code be replayed against another account.
- **Confidential:** yes. **Scopes:** `api` (needed for commits, merge requests and pipelines).

Copy the Application ID and Secret into the API environment.

### 2. API environment

Every `GITLAB_*` variable the API reads (see `src/config/configuration.ts`), plus the one non-prefixed
variable GitLab features also need:

| Variable | Example |
|---|---|
| `GITLAB_URL` | `https://git.ejad.net` (leave empty to disable every GitLab/automation endpoint) |
| `GITLAB_OAUTH_CLIENT_ID`, `GITLAB_OAUTH_CLIENT_SECRET` | from step 1 |
| `GITLAB_OAUTH_REDIRECT_URI` | Must be `<web app URL>/gitlab/callback` (must match step 1 exactly) |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `GITLAB_POLL_INTERVAL_MS` | `20000` (default). `0` turns the pipeline poller off; any other value must be `1000`–`3600000` (1 second to 1 hour) or it falls back to the default |
| `GITLAB_RUN_TIMEOUT_MINUTES` | `120` (default) – unfinished automated runs are closed after this |
| `GITLAB_REQUEST_TIMEOUT_MS` | `15000` (default) – per-request timeout for calls to GitLab's API |

When `GITLAB_URL` is set, `GITLAB_OAUTH_CLIENT_ID`, `GITLAB_OAUTH_CLIENT_SECRET`, `GITLAB_OAUTH_REDIRECT_URI`
and `TOKEN_ENCRYPTION_KEY` become required (the API refuses to start without them).

GitLab tokens are stored AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY`. If you change the key, every
user has to reconnect GitLab. The pipeline poller uses a single in-process `setInterval` (no external
scheduler) and the per-user token-refresh lock lives in memory, so keep a **single** API container.

### 3. Runners

The project needs a GitLab Runner with the **Docker** executor (a shared, group or project runner). The
job uses the official Playwright image. Pick the tag that matches the repository's `@playwright/test`
version, e.g. `mcr.microsoft.com/playwright:v1.47.0-jammy`.

### 4. CI job

Add this job to the repository's `.gitlab-ci.yml`. The Automation tab shows the same snippet (with the
project's Playwright config path) and has a copy button:

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

Pipelines started from the tool set `EJAD_RUN_ID`, and `EJAD_TEST_PATH` / `EJAD_TEST_GREP` for a
folder/file or selected cases. Other jobs in the file also run in these pipelines unless their `rules`
skip `$EJAD_RUN_ID`.

The tool triggers pipelines by sending `EJAD_RUN_ID` etc. as **pipeline variables**, using each tester's
own GitLab permissions. Newer GitLab versions can restrict who is allowed to do that: check
**Settings → CI/CD → Variables → "Minimum role to use pipeline variables"** and make sure it allows the
role every connected tester has in this project, or their triggers will fail.

### 5. Linking tests to test cases

Put the case ID as a tag in the Playwright test title, e.g. `test('logs in @TC-AUTH-001', …)`. When the
pipeline finishes, each tagged test fills that case's result: passed → Passed, failed/error → Failed,
skipped → Skipped. If a case has several tests, it is Failed if any of them failed. Untagged tests show
up as **Unlinked** results with "Create test case from this" (`POST /runs/:runId/results/:resultId/create-case`).
Failed results link to the job's artifacts (`/-/jobs/<id>/artifacts/browse`, which also holds the
Playwright HTML report).

### 6. Connecting and linking

Each tester connects their own GitLab account under **Profile → GitLab**, and every GitLab action uses
that person's permissions. An admin links a project under **Settings → Repository** (GitLab project,
default branch, tests folder, Playwright config path).

### File limits

Reading and editing test files goes through the GitLab API, never the local disk:

- Files **over 1 MB** are downloaded and shown but marked **read-only** (`MAX_EDITABLE_BYTES`). Saving a
  new file, or an existing one, over that size is refused with 413; an existing file's size is checked
  with a HEAD request first, so its content is never downloaded just to reject it.
- Files **over 5 MB** can't be opened at all (`MAX_VIEWABLE_BYTES`): the API never downloads their
  content, just answers 413.
- Files that aren't valid UTF-8 are shown but **read-only**.
- Only `.ts`/`.js` files under the project's `testsPath` can be edited; everything else in `testsPath` is
  viewable but read-only.

Coverage scanning (`GET /projects/:id/automation/coverage`) applies the same 1 MB ceiling per file: files
over that size are skipped without downloading their content, and their paths are listed in the
response's `skippedFiles`.
