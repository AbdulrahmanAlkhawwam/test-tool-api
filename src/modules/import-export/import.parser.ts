import { BadRequestException } from '@nestjs/common';
import { Priority, ResultStatus } from '@prisma/client';
import { CASE_CODE_RE } from '../test-cases/case-code';

type Field =
  | 'code' | 'module' | 'name' | 'description' | 'preconditions' | 'steps'
  | 'testData' | 'expectedResult' | 'actualResult' | 'priority' | 'status' | 'notes';

const HEADER_MAP: Record<string, Field> = {
  'id': 'code',
  'module': 'module',
  'test case name': 'name',
  'description': 'description',
  'preconditions': 'preconditions',
  'test steps': 'steps',
  'test data': 'testData',
  'expected result': 'expectedResult',
  'actual result': 'actualResult',
  'priority': 'priority',
  'status': 'status',
  'notes': 'notes',
};

export interface ImportRow {
  rowNumber: number;
  code: string | null;
  moduleName: string;
  moduleCode: string;
  name: string;
  description: string | null;
  preconditions: string | null;
  steps: string | null;
  testData: string | null;
  expectedResult: string | null;
  actualResult: string | null;
  priority: Priority;
  status: ResultStatus;
  notes: string | null;
  errors: string[];
  warnings: string[];
}

const normalizeHeader = (h: string) => h.toLowerCase().replace(/\s+/g, ' ').trim();

const STATUS_ALIASES: Record<string, ResultStatus> = {
  successed: ResultStatus.PASSED,
  succeeded: ResultStatus.PASSED,
  success: ResultStatus.PASSED,
  passed: ResultStatus.PASSED,
  pass: ResultStatus.PASSED,
  failed: ResultStatus.FAILED,
  fail: ResultStatus.FAILED,
  notexecuted: ResultStatus.NOT_EXECUTED,
  '': ResultStatus.NOT_EXECUTED,
  blocked: ResultStatus.BLOCKED,
  skipped: ResultStatus.SKIPPED,
  skip: ResultStatus.SKIPPED,
};

export function mapStatus(raw: string): ResultStatus | null {
  return STATUS_ALIASES[raw.toLowerCase().replace(/[\s_-]+/g, '')] ?? null;
}

export function mapPriority(raw: string): Priority | null {
  const value = raw.trim().toUpperCase();
  return value in Priority ? (value as Priority) : null;
}

export function deriveModuleCode(moduleName: string): string {
  const words = moduleName.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return 'MOD';
  if (words.length === 1) return words[0].slice(0, 4);
  return words.map((w) => w[0]).join('').slice(0, 10);
}

export function parseImportRows(table: string[][]): ImportRow[] {
  const headerIndex = table.slice(0, 10).findIndex((row) => {
    const names = row.map((c) => normalizeHeader(c ?? ''));
    return names.includes('id') && names.includes('test case name');
  });
  if (headerIndex === -1) {
    throw new BadRequestException('Could not find a header row with "ID" and "Test Case Name" columns');
  }
  const columns = table[headerIndex].map((c) => HEADER_MAP[normalizeHeader(c ?? '')]);

  const seenCodes = new Set<string>();
  const moduleCodes = new Map<string, string>(); // lower-cased module name → code
  const rows: ImportRow[] = [];

  for (let i = headerIndex + 1; i < table.length; i++) {
    const raw: Partial<Record<Field, string>> = {};
    (table[i] ?? []).forEach((cell, col) => {
      const field = columns[col];
      if (field) raw[field] = (cell ?? '').trim();
    });
    if (Object.values(raw).every((v) => !v)) continue;
    rows.push(buildRow(raw, i + 1, seenCodes, moduleCodes));
  }
  return rows;
}

function buildRow(
  raw: Partial<Record<Field, string>>,
  rowNumber: number,
  seenCodes: Set<string>,
  moduleCodes: Map<string, string>,
): ImportRow {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = (f: Field) => raw[f] || null;

  const name = raw.name ?? '';
  if (!name) errors.push('Test Case Name is required');
  const moduleName = raw.module ?? '';
  if (!moduleName) errors.push('Module is required');

  let code: string | null = raw.code ? raw.code.toUpperCase() : null;
  let prefix: string | null = null;
  if (code) {
    const match = code.match(CASE_CODE_RE);
    if (!match) {
      errors.push(`Invalid ID "${raw.code}" (expected format TC-MODULE-001)`);
      code = null;
    } else if (seenCodes.has(code)) {
      errors.push(`Duplicate ID "${code}" in file`);
    } else {
      seenCodes.add(code);
      prefix = match[1];
    }
  } else {
    warnings.push('ID is empty – one will be generated');
  }

  const moduleKey = moduleName.toLowerCase();
  let moduleCode = moduleCodes.get(moduleKey);
  if (!moduleCode) {
    moduleCode = prefix ?? deriveModuleCode(moduleName);
    if (moduleName) moduleCodes.set(moduleKey, moduleCode);
  } else if (prefix && prefix !== moduleCode) {
    warnings.push(`ID prefix "${prefix}" differs from module code "${moduleCode}" – module "${moduleName}" will use "${moduleCode}"`);
  }

  let priority = mapPriority(raw.priority ?? '');
  if (!raw.priority) warnings.push('Priority is empty – set to Medium');
  else if (!priority) warnings.push(`Unknown priority "${raw.priority}" – set to Medium`);
  priority = priority ?? Priority.MEDIUM;

  let status = mapStatus(raw.status ?? '');
  if (!status) warnings.push(`Unknown status "${raw.status}" – treated as Not Executed`);
  status = status ?? ResultStatus.NOT_EXECUTED;

  return {
    rowNumber,
    code,
    moduleName,
    moduleCode,
    name,
    description: text('description'),
    preconditions: text('preconditions'),
    steps: text('steps'),
    testData: text('testData'),
    expectedResult: text('expectedResult'),
    actualResult: text('actualResult'),
    priority,
    status,
    notes: text('notes'),
    errors,
    warnings,
  };
}
