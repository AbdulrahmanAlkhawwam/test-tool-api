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
  /** False when the decoded bytes are not valid UTF-8 (content is then a lossy decoding). */
  isValidUtf8: boolean;
}

/** A file's metadata from a HEAD request, without downloading its content. */
export interface GitlabFileHead {
  size: number;
  lastCommitId: string;
  blobId: string;
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

/** Pipeline (and job) statuses after which GitLab will not run anything else. */
export const FINAL_PIPELINE_STATUSES: ReadonlySet<string> = new Set(['success', 'failed', 'canceled', 'skipped']);

/** The CI job name the tests-repo snippet gives the Playwright job; used to find its test report/artifacts. */
export const EJAD_PLAYWRIGHT_JOB_NAME = 'ejad-playwright';
