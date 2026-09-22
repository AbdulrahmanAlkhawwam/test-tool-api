import { BadRequestException } from '@nestjs/common';

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
  // Same boundary as CASE_TAG_RE (not \b): @TC-AUTH-001 must not also match @TC-AUTH-0010, but it
  // must still match a title suffix like @TC-AUTH-001_smoke, which extractCaseTags() links to this
  // same case when the pipeline's test report comes back.
  if (scope.codes?.length) variables.EJAD_TEST_GREP = scope.codes.map((code) => `@${code}(?![A-Za-z0-9])`).join('|');
  return variables;
}

/** Whitespace and shell/glob metacharacters: unsafe in a PATH scope, which becomes a CI shell variable. */
const UNSAFE_SCOPE_PATH_RE = /[\s*?[\]{}$`'"\\;&|<>]/;

/** Throws 400 when `path` contains whitespace or a character a shell/glob would treat specially. */
export function assertSafeScopePath(path: string): void {
  if (UNSAFE_SCOPE_PATH_RE.test(path)) {
    throw new BadRequestException("Test paths can't contain spaces or special characters");
  }
}

export function automatedRunName(branch: string, at: Date): string {
  return `Automated · ${branch} · ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
