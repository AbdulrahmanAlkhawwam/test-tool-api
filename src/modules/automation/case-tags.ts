/** A test case tag in a Playwright title or `tag` option, e.g. @TC-AUTH-001. */
export const CASE_TAG_RE = /@(TC-[A-Z0-9]+-\d+)(?![A-Za-z0-9])/g;

/** Unique case codes (without "@"), sorted. */
export function extractCaseTags(text: string): string[] {
  return [...new Set([...text.matchAll(CASE_TAG_RE)].map((m) => m[1]))].sort();
}
