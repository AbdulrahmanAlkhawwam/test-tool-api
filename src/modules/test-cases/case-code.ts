export const CASE_CODE_RE = /^TC-([A-Z0-9]+)-(\d+)$/;

/** Next free ID for a module: highest existing number + 1, zero-padded to 3 digits. */
export function nextCaseCode(moduleCode: string, existingCodes: Iterable<string>): string {
  const prefix = `TC-${moduleCode}-`;
  let max = 0;
  for (const code of existingCodes) {
    if (!code.startsWith(prefix)) continue;
    const suffix = code.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    max = Math.max(max, Number(suffix));
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}
