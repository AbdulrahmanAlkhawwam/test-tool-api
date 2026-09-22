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
