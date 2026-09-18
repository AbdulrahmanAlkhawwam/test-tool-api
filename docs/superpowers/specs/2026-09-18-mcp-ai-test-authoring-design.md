# Ejad Test Case Tool — MCP Server for AI Test Authoring (Design Spec)

- **Date:** 2026-09-18
- **Status:** Approved in brainstorming, pending written-spec review
- **Depends on:** Phase 1 (API + web) merged — see `2026-09-18-ejad-test-case-tool-design.md`
- **Order:** built after GitLab automation (`2026-09-18-gitlab-automation-design.md`); `write_playwright_tests`
  output uses the same `@TC-…` tags that the GitLab result import maps back to cases.

## 1. Purpose

Let AI assistants (Claude Code, Claude Desktop, Cursor, any MCP client) work with the Ejad test case tool:

1. **Write test cases into the tool** in the Ejad template (ID, Module, Name, Description, Preconditions,
   Test Steps, Test Data, Expected Result, Priority, Notes) — e.g. "write the test cases for the Forgot
   Password flow of NINJA".
2. **Turn test cases into automated test code** in the user's own repository (Playwright), tagged with the
   case IDs so Phase 2 automation links results back to the cases.

Everything the AI writes is reviewed by a human before it counts.

Success criteria:

1. A tester connects Claude Code to the tool with one command and a personal token.
2. Asking the AI for test cases creates **AI drafts** in the right project/module with generated IDs.
3. Drafts never appear in runs, reports, dashboard counts or exports until a tester approves them.
4. AI edits to approved cases arrive as **suggestions** that a tester accepts or rejects field by field.
5. The AI can fetch cases as an automation spec and, following the built-in prompt, writes one Playwright
   test per case tagged `@TC-…`.

## 2. Scope

**In:** hosted MCP endpoint in the API, personal access tokens, 9 MCP tools + 1 prompt, AI-draft review
flow, change suggestions, token management UI, drafts/suggestions UI.

**Out (not the AI's job):** deleting cases, approving drafts, accepting suggestions, creating/completing
runs, recording results. Also out: a local stdio package (hosted only), writing files on the user's machine
(the AI client does that itself).

## 3. Architecture

- New NestJS module `src/modules/mcp/` in **ejad-testcases-api**, served at **`POST/GET/DELETE /api/mcp`**
  using the official `@modelcontextprotocol/sdk` **Streamable HTTP** transport (stateless mode: one
  `McpServer` per request, no server-side session store — matches the single-container deployment).
- MCP tools call the **existing services** (ProjectsService, ProjectModulesService, TestCasesService,
  ReportsService) so validation, ID generation and role rules are identical to the web app.
- Setup examples (shown in the web app):
  - Claude Code: `claude mcp add --transport http ejad-tests https://<api-host>/api/mcp --header "Authorization: Bearer ejad_pat_…"`
  - Claude Desktop / Cursor: same URL + header in their MCP config.

## 4. Authentication — personal access tokens

- Created in **Profile → AI access** (name + expiry: 30 / 90 / 180 days, default 90). The full token
  `ejad_pat_<32 random base62 chars>` is shown **once**.
- Stored as SHA-256 hash + an 8-char visible prefix. `lastUsedAt` updated at most once per minute.
- Accepted **only on `/api/mcp`**. A PAT sent to any other route → 401. Browser JWTs are **not** accepted
  on `/api/mcp` (keeps the two auth paths separate).
- A token acts as its owner with the owner's role; deactivating the user or revoking/expiring the token → 401.
- Rate limit: 120 MCP requests / minute per token (429 with the uniform error body).

## 5. Data model changes (Prisma)

```
enum ReviewState { APPROVED AI_DRAFT }
enum CreatedVia  { WEB IMPORT AI }
enum SuggestionStatus { PENDING ACCEPTED REJECTED }
enum ApiTokenPurpose { MCP }            // Phase 2 adds RUNNER

TestCase    + reviewState ReviewState @default(APPROVED)
            + createdVia  CreatedVia  @default(WEB)
            + approvedById String?, approvedAt DateTime?

TestCaseSuggestion  id, testCaseId, changes Json   -- { field: { from, to } } for template fields only
                    status SuggestionStatus @default(PENDING), rationale String?,
                    createdById, createdAt, resolvedById?, resolvedAt?

ApiToken    id, userId, name, purpose ApiTokenPurpose @default(MCP), tokenHash @unique, prefix,
            expiresAt, lastUsedAt?, revokedAt?, createdAt
```

Migration is additive; existing cases become `APPROVED` / `WEB` (import-created cases keep `WEB` —
backfilling is not needed).

## 6. Rules

- `create_test_cases` (MCP) always creates `reviewState = AI_DRAFT`, `createdVia = AI`. IDs are generated
  exactly like the web app (`TC-{MODULE}-{NNN}`); a rejected draft's ID is never reused (soft delete).
- **Drafts are excluded** from: run creation snapshots, `latest status` filters, reports/dashboard counts,
  project case counts, and export. The Test Cases list shows them only under the "AI drafts" filter (and
  in the default list with a 🤖 badge — see §8).
- **Approve** (web, any tester/admin): sets `APPROVED`, `approvedById/At`. **Reject**: soft delete.
- **Edits by AI:**
  - to its drafts: applied directly (still a draft);
  - to an approved case: stored as a `TestCaseSuggestion` (PENDING); the case is unchanged. Only one
    pending suggestion per case — a new one replaces the previous pending one.
- **Accept suggestion:** applies the listed field changes (validated like a normal edit), marks ACCEPTED.
  If the case changed after the suggestion was created in a field the suggestion touches, the accept is
  rejected with 409 "The test case changed since this suggestion – review it again".
- Batch limit: `create_test_cases` ≤ 50 cases per call; each case validated individually; the call returns
  per-item results (created code or error) — valid items are created even if some fail.

## 7. MCP surface

All tools return JSON text content; errors use MCP tool errors with the API's message.

| Tool | Input | Output |
|---|---|---|
| `list_projects` | `includeArchived?` | key, name, description, caseCount, latestRun summary |
| `get_project` | `projectKey` | project + modules (name, code, caseCount) |
| `list_test_cases` | `projectKey, moduleCode?, priority?, status?, q?, includeDrafts? (default true), page?, pageSize? (≤100)` | cases with code, name, module, priority, reviewState, latest status |
| `get_test_case` | `projectKey, code` | full template fields, reviewState, pending suggestion, result history (last 10) |
| `create_module` | `projectKey, name, code?` (derived like import if omitted) | module |
| `create_test_cases` | `projectKey, cases[]` — each `{ moduleCode, name, description?, preconditions?, steps?, testData?, expectedResult?, priority?, notes? }` | per-item `{ ok, code? , error? }` |
| `update_test_case` | `projectKey, code, changes{…template fields}, rationale?` | `{ applied: true }` for drafts, or `{ suggestionId }` for approved cases |
| `get_failing_cases` | `projectKey` | failing cases with actual result, run, executedAt |
| `get_test_cases_for_automation` | `projectKey, moduleCode? , codes?[]` (approved only) | ordered spec: code, name, preconditions, steps, testData, expectedResult, priority |

**Prompt** `write_playwright_tests(projectKey, moduleCode?)`: instructs the AI to call
`get_test_cases_for_automation`, then write one Playwright `test()` per case titled
`'<name> @<code>'`, following the steps/test data and asserting the expected result, grouping by module
in `describe` blocks, and not inventing behaviour beyond the case text (ask the user when unclear).

## 8. Web changes (ejad-testcases-web)

- **Test Cases tab:** "🤖 AI drafts (N)" filter chip; draft rows show an "AI draft" badge with **Approve**
  / **Edit** / **Reject**; checkbox selection + **Approve selected**.
- **Test case page:** draft banner with Approve/Reject; "Suggested changes by AI" panel listing each field
  old → new with the rationale; **Accept** / **Reject**.
- **Profile → AI access:** create token (name, expiry), one-time token display with copy button, list
  (name, prefix, created, last used, expires) with **Revoke**; setup snippets for Claude Code, Claude
  Desktop and Cursor using the real API URL.
- Case history/detail shows "Created by <name> via AI" and "Approved by <name>".

## 9. API endpoints (non-MCP, for the web app)

```
GET    /api/users/me/tokens            list own tokens
POST   /api/users/me/tokens            { name, expiresInDays: 30|90|180 } → { token (once), …meta }
DELETE /api/users/me/tokens/:id        revoke
POST   /api/test-cases/:id/approve     draft → approved
POST   /api/test-cases/approve         { ids[] } bulk approve (same project)
GET    /api/test-cases/:id/suggestion  pending suggestion or null
POST   /api/suggestions/:id/accept     apply (409 if stale)
POST   /api/suggestions/:id/reject
GET    /api/projects/:id/test-cases?reviewState=AI_DRAFT   (new filter)
```

## 10. Error handling

- PAT problems → 401 `Invalid or expired access token`; PAT on non-MCP route → 401.
- MCP tool validation errors → MCP tool error with the field messages (not a transport error).
- Batch create returns per-item errors; never all-or-nothing.
- Stale suggestion accept → 409 (see §6).

## 11. Testing

- **Unit:** token generation/hash/prefix; suggestion diff builder (only changed template fields);
  stale-suggestion detection.
- **API e2e** (real MCP client `@modelcontextprotocol/sdk` Client + StreamableHTTPClientTransport against
  the test app): list_projects; create_test_cases → drafts with generated codes and per-item errors;
  drafts excluded from run creation, reports and export until approved; update_test_case on draft
  (applied) vs approved (suggestion); accept/reject/stale 409; revoked/expired token 401; PAT rejected on
  `/api/projects`; JWT rejected on `/api/mcp`; get_test_cases_for_automation excludes drafts; prompt listed.
- **Web:** component tests for drafts filter + bulk approve and the suggestion panel; Playwright step:
  create a draft via the API, approve it in the UI, see it in a new run.

## 12. Delivery order

1. API: schema + migration, ApiToken service + guard, review/suggestion rules in TestCases/Runs/Reports/Export.
2. API: MCP module (transport, tools, prompt) + e2e with a real MCP client.
3. Web: Profile → AI access; drafts UI; suggestion panel; Playwright step.
4. Docs: README "Connect your AI" section.
