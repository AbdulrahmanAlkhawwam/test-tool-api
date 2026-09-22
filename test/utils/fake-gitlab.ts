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
  /**
   * The file's raw bytes, when they aren't just `content` re-encoded as UTF-8 (e.g. a fixture
   * that is deliberately not valid UTF-8). Falls back to `Buffer.from(content, 'utf8')`.
   */
  bytes?: Buffer;
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
  /** null for a repository with no commits yet, matching GitLab's own `default_branch: null`. */
  default_branch: string | null;
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
  private tokenGate: (() => Promise<void>) | null = null;
  private commitGate: (() => Promise<void>) | null = null;
  private forcedTokenResponse: { status: number; body: unknown } | null = null;
  private breakUserFetch = false;
  private forcedMrCreateConflict = false;
  private breakMergeRequestList = false;

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
    this.tokenGate = null;
    this.commitGate = null;
    this.forcedTokenResponse = null;
    this.breakUserFetch = false;
    this.forcedMrCreateConflict = false;
    this.breakMergeRequestList = false;
  }

  /**
   * Delays every subsequent `/oauth/token` response until the returned function is called — lets
   * a test pause a request mid-flight (e.g. to race a disconnect or another refresher against it)
   * and then let it proceed.
   */
  holdTokenResponses(): () => void {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tokenGate = () => gate;
    return () => {
      release();
      this.tokenGate = null;
    };
  }

  /** Makes the very next `/oauth/token` request answer with this status/body instead of normal processing. */
  forceNextTokenResponse(status: number, body: unknown): void {
    this.forcedTokenResponse = { status, body };
  }

  /** Makes the very next `GET /api/v4/user` request fail with a 500, to simulate a post-exchange failure. */
  breakNextUserFetch(): void {
    this.breakUserFetch = true;
  }

  /**
   * Delays every subsequent `POST /repository/commits` response until the returned function is
   * called — lets a test pause a commit mid-flight (e.g. to race a concurrent push against it)
   * and then let it proceed with the request body already sent.
   */
  holdCommitRequests(): () => void {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.commitGate = () => gate;
    return () => {
      release();
      this.commitGate = null;
    };
  }

  /** Makes the very next `POST .../merge_requests` answer 409, as if another request won the race to create one. */
  forceNextMergeRequestCreateConflict(): void {
    this.forcedMrCreateConflict = true;
  }

  /** Makes the very next `GET .../merge_requests` request fail with a 500. */
  breakNextMergeRequestList(): void {
    this.breakMergeRequestList = true;
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

  /** A freshly created GitLab project with no commits: GitLab reports `default_branch: null` for these. */
  addEmptyProject(data: { id: number; path: string; members?: FakeUser[] }): FakeProject {
    const project: FakeProject = {
      id: data.id,
      name: data.path.split('/').pop()!,
      path_with_namespace: data.path,
      web_url: `${this.url}/${data.path}`,
      default_branch: null,
      ciEnabled: true,
      memberIds: new Set((data.members ?? []).map((m) => m.id)),
      branches: new Map(),
    };
    this.projects.set(project.id, project);
    return project;
  }

  addMember(projectId: number, user: FakeUser): void {
    this.projects.get(projectId)!.memberIds.add(user.id);
  }

  addBranch(projectId: number, name: string, from?: string): FakeBranch {
    const project = this.projects.get(projectId)!;
    const source = project.branches.get(from ?? project.default_branch ?? '')!;
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

  /** Like `setFile`, but for content that is deliberately not valid UTF-8 (raw bytes, not text). */
  setBinaryFile(projectId: number, branch: string, path: string, bytes: Buffer): string {
    const b = this.branch(projectId, branch)!;
    const commitId = sha();
    b.files.set(path, { content: bytes.toString('utf8'), bytes, lastCommitId: commitId });
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

    app.post('/oauth/token', async (req, res) => {
      if (this.tokenGate) await this.tokenGate();
      if (this.forcedTokenResponse) {
        const { status, body } = this.forcedTokenResponse;
        this.forcedTokenResponse = null;
        res.status(status).json(body);
        return;
      }
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
      if (this.breakUserFetch) {
        this.breakUserFetch = false;
        res.status(500).json({ message: 'simulated failure' });
        return;
      }
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

    // Registered before the GET route below: Express treats a GET-only route as also matching
    // HEAD (mirroring real HTTP semantics), so without this order a HEAD request would never
    // reach this dedicated handler and would instead get the GET route's JSON body stripped of
    // just its bytes, none of the X-Gitlab-* headers.
    api.head('/projects/:id/repository/files/:filePath', (req, res) => {
      const p = project(req, res);
      if (!p) return;
      const ref = String(req.query.ref ?? p.default_branch);
      const branch = this.resolveRef(p, ref);
      const path = String(req.params.filePath);
      const file = branch?.files.get(path);
      if (!branch || !file) {
        res.status(404).end();
        return;
      }
      const bytes = file.bytes ?? Buffer.from(file.content, 'utf8');
      res.set({
        'X-Gitlab-Size': String(bytes.length),
        'X-Gitlab-Last-Commit-Id': file.lastCommitId,
        'X-Gitlab-Blob-Id': sha(),
      });
      res.status(200).end();
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
      const bytes = file.bytes ?? Buffer.from(file.content, 'utf8');
      res.json({
        file_name: path.split('/').pop(),
        file_path: path,
        size: bytes.length,
        encoding: 'base64',
        content: bytes.toString('base64'),
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

    api.post('/projects/:id/repository/commits', async (req, res) => {
      if (this.commitGate) await this.commitGate();
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
      if (this.breakMergeRequestList) {
        this.breakMergeRequestList = false;
        res.status(500).json({ message: 'simulated failure' });
        return;
      }
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
      if (this.forcedMrCreateConflict) {
        this.forcedMrCreateConflict = false;
        // Simulate a concurrent request that already created the MR we were about to: plant it
        // (if it's not there yet) so a caller that reacts to this 409 by re-listing finds it.
        if (!this.mergeRequests.some((m) => m.project_id === p.id && m.source_branch === b.source_branch && m.state === 'opened')) {
          const iid = this.mergeRequests.filter((m) => m.project_id === p.id).length + 1;
          this.mergeRequests.push({
            iid,
            project_id: p.id,
            source_branch: b.source_branch,
            target_branch: b.target_branch,
            title: b.title,
            description: b.description ?? '',
            state: 'opened',
            web_url: `${p.web_url}/-/merge_requests/${iid}`,
          });
        }
        res.status(409).json({ message: ['Another open merge request already exists for this source branch'] });
        return;
      }
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
