const INTRO = 'Test changes made in the Ejad test case tool.';
const FILES_HEADER = '**Edited files**';
const CASES_HEADER = '**Linked test cases**';

/** Items of a "- item" list directly under `header` in a description this module wrote. */
function readList(description: string | null, header: string): string[] {
  if (!description) return [];
  const lines = description.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = line.trim().match(/^- `?([^`]+?)`?$/);
    if (!match) break;
    if (match[1] !== 'none') items.push(match[1]);
  }
  return items;
}

/** Description for the work-branch MR: all files edited so far and all case codes they tag. */
export function buildMrDescription(previous: string | null, file: string, caseCodes: string[]): string {
  const files = [...new Set([...readList(previous, FILES_HEADER), file])].sort();
  const cases = [...new Set([...readList(previous, CASES_HEADER), ...caseCodes])].sort();
  return [
    INTRO,
    '',
    FILES_HEADER,
    ...files.map((f) => `- \`${f}\``),
    '',
    CASES_HEADER,
    ...(cases.length ? cases.map((c) => `- ${c}`) : ['- none']),
  ].join('\n');
}

export function mergeRequestTitle(workName: string): string {
  return `Tests: ${workName.trim()}`.slice(0, 255);
}
