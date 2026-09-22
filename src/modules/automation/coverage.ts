export interface FileTags {
  path: string;
  codes: string[];
}

export interface CoverageCase {
  id: string;
  code: string;
  name: string;
  module: { code: string; name: string };
}

export interface FileCoverage {
  path: string;
  cases: { id: string; code: string; name: string }[];
  unknownCodes: string[];
}

export interface Coverage {
  files: FileCoverage[];
  notAutomated: CoverageCase[];
}

/** Which active cases each test file covers, and which cases no file covers yet. */
export function computeCoverage(files: FileTags[], cases: CoverageCase[]): Coverage {
  const byCode = new Map(cases.map((c) => [c.code, c]));
  const covered = new Set<string>();
  const fileCoverage = [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => {
      const known = file.codes.filter((code) => byCode.has(code));
      known.forEach((code) => covered.add(code));
      return {
        path: file.path,
        cases: known.map((code) => {
          const testCase = byCode.get(code)!;
          return { id: testCase.id, code: testCase.code, name: testCase.name };
        }),
        unknownCodes: file.codes.filter((code) => !byCode.has(code)),
      };
    });
  return { files: fileCoverage, notAutomated: cases.filter((c) => !covered.has(c.code)) };
}
