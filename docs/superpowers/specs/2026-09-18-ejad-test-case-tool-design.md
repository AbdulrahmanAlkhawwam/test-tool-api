# Ejad Test Case Tool — Design Spec

- **Date:** 2026-09-18
- **Status:** Approved in brainstorming, pending written-spec review
- **Owner:** Ejad QA / Engineering

## 1. Purpose

An internal web tool where Ejad teams manage **projects**, write **manual test cases** in the
company template, **execute** them in test runs with full history, and (Phase 2) run **local
Playwright automation** whose results are saved on the server.

Success criteria:

1. A tester can import the existing Excel sheet (e.g. the AUTH sheet, TC-AUTH-001…040) into a project
   with no manual re-typing, and export it back in the same column order.
2. A tester can start a run, record Actual Result / Status / Notes per case, and every change is
   saved instantly and stays visible in the list.
3. Every run is kept; the history of any case across runs is visible.
4. The home page shows all projects with their latest pass/fail status.
5. (Phase 2) A tester clicks **Run automation** in the web app, Playwright runs on their own machine
   from a folder they configured, and results appear live in an Automated run.

## 2. Scope

### Phase 1 — Manual tool (v1)
Projects, modules, test cases (company template), manual test runs with history, instant-save
execution, Excel/CSV import & export, dashboard & reports, Admin + Tester roles.

### Phase 2 — Automation
Local runner CLI (`ejad-runner`), per-tester local path per project, Run automation button,
live result streaming, tag-based linking, unlinked results, failure screenshots/traces in RustFS/S3.

### Out of scope (later)
Manual screenshot attachments, Arabic/RTL UI, per-project membership/permissions, Jira/issue
tracker links, public automation API keys for CI, structured (row-per-step) test steps.

## 3. Company test case template → fields

| Sheet column     | Where it lives                    |
|------------------|-----------------------------------|
| ID               | `TestCase.code` (e.g. TC-AUTH-001)|
| Module           | `TestCase.moduleId` → `Module`    |
| Test Case Name   | `TestCase.name`                   |
| Description      | `TestCase.description`            |
| Preconditions    | `TestCase.preconditions`          |
| Test Steps       | `TestCase.steps` (multi-line text)|
| Test Data        | `TestCase.testData`               |
| Expected Result  | `TestCase.expectedResult`         |
| Actual Result    | `TestResult.actualResult` (per run)|
| Priority         | `TestCase.priority`               |
| Status           | `TestResult.status` (per run)     |
| Notes            | `TestCase.notes` (definition notes) and `TestResult.notes` (execution notes) |

Definition (what to test) and execution (what happened in a given run) are separate entities.

## 4. Architecture

Two repositories, each with its own Dockerfile and Dokploy service:

- **`ejad-testcases-api`**: NestJS + Prisma + PostgreSQL. Also contains `runner/` (Phase 2),
  published as the npm CLI `ejad-runner`.
- **`ejad-testcases-web`**: Next.js (App Router) + TypeScript + Tailwind + shadcn/ui + TanStack Query + Recharts.

Dokploy services: `web`, `api`, `postgres`, and in Phase 2 `rustfs` (S3-compatible storage).

```
Browser ──HTTPS──▶ web (Next.js) ──HTTPS/JSON──▶ api (NestJS) ──▶ PostgreSQL
                                                   ▲   │
                              Phase 2: WebSocket   │   └──▶ RustFS (screenshots, traces)
                                                   │
                         Tester laptop: ejad-runner ──▶ npx playwright test (in configured folder)
```

Environment variables: `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CORS_ORIGIN`
(api); `API_URL` (web); Phase 2: `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`.

## 5. Data model (Prisma)

```
enum Role            { ADMIN TESTER }
enum Priority        { HIGH MEDIUM LOW }
enum RunType         { MANUAL AUTOMATED }
enum RunStatus       { IN_PROGRESS COMPLETED }
enum ResultStatus    { NOT_EXECUTED PASSED FAILED BLOCKED SKIPPED }
enum AttachmentKind  { SCREENSHOT TRACE VIDEO }

User        id, name, email (unique), passwordHash, role, active (default true), createdAt, updatedAt

Project     id, name, key (unique, uppercase, e.g. "NINJA"), description?, createdById,
            archivedAt?, createdAt, updatedAt

Module      id, projectId, name ("Authentication"), code ("AUTH"), createdAt
            unique(projectId, code)

TestCase    id, projectId, moduleId,
            code          -- "TC-AUTH-001", unique(projectId, code)
            name, description?, preconditions?, steps?, testData?, expectedResult?,
            priority (default MEDIUM), notes?,
            createdById, updatedById, createdAt, updatedAt, deletedAt?

TestRun     id, projectId, name, build?, environment?,
            type (default MANUAL), status (default IN_PROGRESS),
            createdById, startedAt, completedAt?

TestResult  id, runId, testCaseId?,        -- null only for Phase 2 "Unlinked" automated results
            title?,                        -- Phase 2: Playwright test title
            status (default NOT_EXECUTED), actualResult?, notes?,
            durationMs?, errorMessage?, errorStack?,   -- Phase 2
            executedById?, executedAt?, updatedAt
            unique(runId, testCaseId)

-- Phase 2 tables (created in Phase 2 migration)
Attachment  id, resultId, kind, storageKey, size, contentType, createdAt
RunnerToken id, userId, name, tokenHash, lastSeenAt?, revokedAt?, createdAt
RunnerPath  id, userId, projectId, localPath, updatedAt
            unique(userId, projectId)
```

Rules:

- **Test case ID generation:** `TC-{module.code}-{NNN}`, where NNN is the max existing number for
  that module prefix + 1, zero-padded to 3 digits. Generated in a transaction so concurrent inserts
  can't collide (retry on unique violation). Imported cases keep their IDs from the sheet.
- **Soft delete** for test cases (`deletedAt`). Deleted cases are hidden from lists and new runs,
  but past results still show them.
- **Run creation takes a snapshot:** it creates one `NOT_EXECUTED` result per selected case
  (all, or filtered by module, priority or explicit selection). Cases added later don't change existing runs.
- **Completed runs are read-only.** Result edits are rejected with 409.
- Projects are archived, not hard-deleted, and archived projects are hidden from home by default.

## 6. Roles & permissions

| Action                                         | ADMIN | TESTER |
|------------------------------------------------|:-----:|:------:|
| View all projects, cases, runs, reports        | ✅    | ✅     |
| Create / edit / archive projects               | ✅    | ❌     |
| Manage users (create, deactivate, set role)    | ✅    | ❌     |
| Create / edit / delete modules & test cases    | ✅    | ✅     |
| Import / export                                | ✅    | ✅     |
| Create runs, record results, complete runs     | ✅    | ✅     |
| Phase 2: configure own local path, own tokens  | ✅    | ✅     |

The first admin is created by the seed script (from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`).
There is no self-registration.

## 7. Screens (web)

1. **Login** (`/login`): email and password.
2. **Home** (`/`): project cards showing name, key, case count, a stacked pass/fail/blocked/not-executed
   bar from the latest run, and a "last tested" time. Admins see **+ New Project**. Search by name.
3. **Project** (`/projects/[key]`) with tabs:
   - **Test Cases**: table with the template columns plus the latest result status. Filters for
     module, priority, latest status and text search. Buttons: **+ New Test Case**, **Import**, **Export**,
     and module management (add/rename module and code).
   - **Runs**: list with name, type, build, environment, progress bar, status and creator. **+ New Run** opens a
     dialog for name, build, environment and case selection (all / by module / by priority / pick).
   - **Dashboard**: pass-rate trend across runs, breakdown by module and priority, and a list of
     currently failing cases (last result FAILED).
   - **Settings**: project info (admin), and in Phase 2 the Automation section.
4. **Test case detail** (`/projects/[key]/cases/[code]`): full definition (editable) plus result
   history across all runs (run, date, status, actual result, tester).
5. **Run execution** (`/projects/[key]/runs/[id]`): see §8.
6. **Admin → Users** (`/admin/users`): list, create, deactivate, change role, reset password.
7. **Profile** (`/profile`): change password. In Phase 2 also runner tokens.

## 8. Run execution behavior (key UX requirement)

- A progress header shows "23 / 40 executed · 18 passed · 2 failed · 1 blocked", with a progress bar.
- Each row shows the case's code, name, module and priority. It expands to show preconditions, steps,
  test data and expected result, next to the **Status** selector, **Actual Result** and **Notes**.
- **Instant save:** changing Status saves immediately. Actual Result and Notes save on blur and
  after 800 ms of no typing. The row shows "Saving…" and then "Saved ✓".
- **Save failure:** the row shows "Not saved – retry". The typed text stays in the field
  and is never discarded. It retries automatically once, then waits for a manual retry click.
- **Nothing hides:** executed rows stay in place and are coloured by status (Passed green,
  Failed red, Blocked amber, Skipped slate, Not Executed grey), showing "executedBy · time".
- Results can be re-edited while the run is IN_PROGRESS. Filters such as "Only Not Executed" exist,
  but they are **off by default**.
- **Complete Run** asks for confirmation (with a warning if any results are still Not Executed) and then locks the run.
- **Export results** downloads an .xlsx in the template's column order, with Actual Result and Status from this run.
- Two testers can work in the same run at once. The last write wins per result, and the list
  refetches on window focus so testers see each other's updates.

## 9. API (NestJS)

Modules: `auth`, `users`, `projects`, `modules`, `test-cases`, `runs`, `results`,
`import-export`, `reports`, and in Phase 2 `runner`, `attachments`.

```
POST   /auth/login                      → access token (15 min) + refresh cookie (httpOnly, 7 days)
POST   /auth/refresh | /auth/logout
GET    /auth/me

GET    /users | POST /users | PATCH /users/:id               (ADMIN)
PATCH  /users/me/password

GET    /projects                         (with latest-run summary for the home cards)
POST   /projects | PATCH /projects/:id   (ADMIN)
GET    /projects/:key

GET    /projects/:id/modules | POST | PATCH /modules/:id | DELETE /modules/:id (only if empty)

GET    /projects/:id/test-cases?module=&priority=&status=&q=&page=
POST   /projects/:id/test-cases
GET    /test-cases/:id  (includes result history)
PATCH  /test-cases/:id | DELETE /test-cases/:id (soft)

POST   /projects/:id/import/preview      multipart .xlsx/.csv → parsed rows, errors, duplicates
POST   /projects/:id/import/confirm      { importId, duplicateStrategy: skip|update, createImportedRun: bool }
GET    /projects/:id/test-cases/export   → .xlsx

GET    /projects/:id/runs | POST /projects/:id/runs
GET    /runs/:id (with results) | PATCH /runs/:id (rename, complete)
PATCH  /runs/:runId/results/:resultId    { status?, actualResult?, notes? }  → 409 if run completed
GET    /runs/:id/export                  → .xlsx

GET    /projects/:id/reports             trend, by module, by priority, failing cases
GET    /dashboard                        home summary
```

- Validation uses `class-validator` DTOs, with a global `ValidationPipe` (whitelist, transform).
- Errors use one shape: `{ statusCode, error, message, details? }`.
- Swagger docs are at `/docs`, and login is rate-limited with `@nestjs/throttler`.

## 10. Import / Export

- Parsing uses `exceljs` for .xlsx and `csv-parse` for .csv. It reads the first sheet, and the header row is detected by matching
  known column names (case- and space-insensitive, e.g. "Status " is accepted), so column order doesn't matter.
- **Modules:** created automatically from the Module column. The module code is derived from the ID prefix
  (`TC-AUTH-001` → `AUTH`), or from the uppercase initials of the module name if the ID is missing.
- **Status mapping** (only used when `createImportedRun` is true): "Successed"/"Passed"/"Pass" →
  PASSED; "Failed"/"Fail" → FAILED; "Not Executed"/empty → NOT_EXECUTED; "Blocked" → BLOCKED;
  "Skipped" → SKIPPED. Unknown values are reported as row errors.
- **Priority mapping:** High/Medium/Low (case-insensitive), with Medium as the default and a warning.
- **Preview** returns every row with its errors and warnings, plus duplicates (IDs that already exist in the
  project). Nothing is written until the user confirms. Previews are kept for 30 minutes.
- **Export** uses the exact template column order and header text, keeps multi-line cells, and makes the header
  row bold and frozen.

## 11. Phase 2 — Automation

### Runner (`ejad-runner`, in `ejad-testcases-api/runner/`)
- Install/run: `npx ejad-runner login --server https://… --token <token>`, then `npx ejad-runner start`.
  The config is stored in the user's home directory (`~/.ejad-runner.json`).
- `start` opens an authenticated **outbound WebSocket** to the API and sends a heartbeat every 15 s.
  The API marks the tester's runner online/offline, and the web UI shows the status.
- On a `run` job `{ runId, projectId, localPath, grepTags[] }`:
  1. The runner verifies that `localPath` exists and contains `playwright.config.(ts|js|mjs)`.
  2. It spawns `npx playwright test` **without a shell** (`spawn` with an args array), in that folder,
     with `--reporter=<bundled ejad reporter>` and, if tags are given, `--grep` built from escaped
     tags (`@TC-AUTH-001|@TC-AUTH-002`).
  3. The bundled reporter posts each test result as it finishes: status, duration, error message and stack,
     and uploads screenshot/trace attachments.
  4. When Playwright exits, the runner calls "finish run".
- **Security:** the runner accepts only `run`/`cancel` jobs for projects the token owner can access. The command is
  fixed, and the server can't send arbitrary commands or arguments. Tokens are hashed server-side
  and can be revoked. One job runs at a time per runner.

### Linking & mapping
- A tag in the test title or annotations (`@TC-AUTH-001`) links the result to that test case.
- Playwright status mapping: passed → PASSED, failed/timedOut → FAILED, skipped → SKIPPED,
  interrupted → BLOCKED.
- Tests with no tag or an unknown tag become **Unlinked** results (`testCaseId = null`, `title` set),
  with a **Create test case from this** action that pre-fills name and module.
- A case that has at least one linked automated result gets a 🤖 badge.

### Web
- Project → Settings → Automation lets each tester set their local folder path (`RunnerPath`), and shows
  runner status and setup instructions.
- **Run automation** (Runs tab) is enabled only when the current tester's runner is online. The scope is
  all / module / selected cases. It creates an AUTOMATED run and dispatches the job.
- The Automated run view updates live via WebSocket. Failed rows show the error and a screenshot thumbnail,
  with a trace download.
- Profile → Runner tokens lets testers create (shown once) and revoke tokens.

### API additions
```
WS     /runner                               (token auth; heartbeat, job dispatch, job ack)
POST   /runner/runs/:id/results              (reporter → result per test)
POST   /runner/runs/:id/attachments          (multipart → RustFS)
POST   /runner/runs/:id/finish
PUT    /projects/:id/runner-path             { localPath }
GET    /runner/status                        (current user's runner online?)
POST   /projects/:id/runs/automated          { scope } → creates run, dispatches job
GET/POST/DELETE /users/me/runner-tokens
```

## 12. Error handling

- **API:** a global exception filter returns the uniform error shape, and Prisma unique violations are mapped to 409
  with a readable message. Results cannot change on completed runs (409). Validation errors return 400 with
  field details.
- **Web:** form fields show validation errors inline, server errors appear as toasts, row-level save states show in the
  run execution view (§8), and import shows a row-by-row error table. An expired session refreshes silently,
  or redirects to login if the refresh fails.
- **Phase 2:** a folder that doesn't exist or a missing Playwright config is reported back and shown on the run. If
  the runner disconnects mid-run, the run is marked COMPLETED with the remaining results left NOT_EXECUTED and a note
  "Runner disconnected".

## 13. Testing

**API (Jest)**
- Unit tests: test case ID generator (including concurrency retry), import header detection, status and priority
  mapping, module code derivation.
- E2E tests (Supertest against a disposable Postgres): login/refresh, role guards (tester can't create
  projects or users), run creation snapshot, result instant-save, completed-run lock (409),
  import preview → confirm, export column order.
- Phase 2: reporter → API result ingestion, tag linking, unlinked results, and a runner spawn using a fixture
  Playwright project.

**Web**
- Component tests (Vitest + Testing Library): execution row save / saving / saved / failed-retry
  states, and that typed text is never lost.
- Playwright E2E happy path: log in → create project → add case → start run → mark Failed with actual
  result → complete run → case history shows the failure.

## 14. Implementation decisions (added during planning)

- The Prisma model for modules is named **`ProjectModule`** (the spec says `Module`), to avoid clashing
  with NestJS's `@Module` decorator. The API path stays `/modules`.
- All API routes are under the global prefix **`/api`**, and Swagger is at **`/api/docs`**
  (following `ninja-store-api`).
- **"Latest result" of a case** = its most recent result whose status is not NOT_EXECUTED (by
  `executedAt`). A case with none counts as NOT_EXECUTED. Creating a new run therefore does not
  reset a case's latest status to grey. The home project card still shows the **latest run's** counts.
- **Import:** an unknown Status value is a **warning** and is treated as Not Executed, rather than a
  row error, so it never blocks importing the case definition. A single-word module name with no
  ID derives its code from its first 4 letters (`Authentication` → `AUTH`), and a multi-word name
  from its initials (`User Management` → `UM`).
- **Modules** can be deleted only when they have no test cases at all, including soft-deleted ones.
- **Passwords** use `bcryptjs` (no native build in Alpine images).

## 15. Delivery order

1. API foundation: auth, users, projects, modules, test cases.
2. Web foundation: login, home, project, test cases CRUD.
3. Runs + execution screen (instant save).
4. Import / export.
5. Dashboard & reports.
6. Docker + Dokploy deploy (Phase 1 release).
7. Phase 2: runner tokens, WebSocket, runner CLI + reporter, RustFS attachments, automation UI.
