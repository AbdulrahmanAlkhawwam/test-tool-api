import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GitlabConfig } from '../../config/configuration';
import { GitlabHttpError, gitlabErrorMessage } from './gitlab-http-error';
import {
  CommitAction,
  GitlabBranch,
  GitlabCommit,
  GitlabFile,
  GitlabFileHead,
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

/** Whether `bytes` decode as strict UTF-8 (a lossy decode never throws, so this needs its own check). */
function isValidUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

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
      const bytes = Buffer.from(f.content, 'base64');
      return {
        path: f.file_path,
        size: f.size,
        content: bytes.toString('utf8'),
        lastCommitId: f.last_commit_id,
        isValidUtf8: isValidUtf8(bytes),
      };
    } catch (e) {
      if (e instanceof GitlabHttpError && e.status === 404) return null;
      throw e;
    }
  }

  /** A file's size and last commit id without downloading its content (a HEAD request). */
  async headFile(token: string, projectId: number, ref: string, path: string): Promise<GitlabFileHead | null> {
    try {
      const { headers } = await this.request<null>(token, 'HEAD', `/projects/${projectId}/repository/files/${encodeURIComponent(path)}`, {
        query: { ref },
      });
      return {
        size: Number(headers.get('x-gitlab-size')),
        lastCommitId: headers.get('x-gitlab-last-commit-id') ?? '',
        blobId: headers.get('x-gitlab-blob-id') ?? '',
      };
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
