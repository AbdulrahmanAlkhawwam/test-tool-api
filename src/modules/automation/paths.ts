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
