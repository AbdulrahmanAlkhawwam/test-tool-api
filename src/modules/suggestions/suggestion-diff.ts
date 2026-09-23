/**
 * The only fields an AI may propose changing (spec §5: "template fields only"). `id`, `code`,
 * `moduleId`, `projectId`, `reviewState`, `createdVia`, `approvedById` and `deletedAt` are
 * deliberately absent: a suggestion can reword a case, never move it, rename its ID or approve it.
 */
export const SUGGESTION_FIELDS = [
  'name',
  'description',
  'preconditions',
  'steps',
  'testData',
  'expectedResult',
  'priority',
  'notes',
] as const;

export type SuggestionField = (typeof SUGGESTION_FIELDS)[number];
export type SuggestionValue = string | null;

export interface SuggestionChange {
  from: SuggestionValue;
  to: SuggestionValue;
}

export type SuggestionChanges = Partial<Record<SuggestionField, SuggestionChange>>;
/** A proposal, or a case's own values. `undefined` means "not mentioned". */
export type ProposedFields = Partial<Record<SuggestionField, string | null | undefined>>;

/** Fields that may be cleared. `name` and `priority` must always hold a value. */
const NULLABLE: ReadonlySet<string> = new Set([
  'description',
  'preconditions',
  'steps',
  'testData',
  'expectedResult',
  'notes',
]);

const FIELD_SET: ReadonlySet<string> = new Set(SUGGESTION_FIELDS);

/** Stored value of a field: an empty string and a missing value both mean "cleared". */
function normalizeStored(field: SuggestionField, value: string | null | undefined): SuggestionValue {
  if (value === undefined || value === null || value === '') return null;
  return value;
}

/**
 * Normalizes a *proposed* value, or returns `undefined` for "do not touch this field": absent,
 * or an attempt to blank a field that cannot be blank. Length and enum validation happens before
 * this (the MCP tool's zod schema / the DTO); this function only decides what changed.
 */
function normalizeProposed(field: SuggestionField, value: string | null | undefined): SuggestionValue | undefined {
  if (value === undefined) return undefined;
  if (NULLABLE.has(field)) return value === null || value === '' ? null : value;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `{ field: { from, to } }` for the template fields that `proposed` actually changes. */
export function buildSuggestionChanges(current: ProposedFields, proposed: ProposedFields): SuggestionChanges {
  const changes: SuggestionChanges = {};
  for (const field of SUGGESTION_FIELDS) {
    const to = normalizeProposed(field, proposed[field]);
    if (to === undefined) continue;
    const from = normalizeStored(field, current[field]);
    if (from === to) continue;
    changes[field] = { from, to };
  }
  return changes;
}

/**
 * True when the case has moved on in a field this suggestion touches (spec §6). Fields the
 * suggestion leaves alone are ignored on purpose: a tester editing the name must not invalidate
 * an AI's suggestion about the steps.
 */
export function isSuggestionStale(changes: SuggestionChanges, current: ProposedFields): boolean {
  for (const field of SUGGESTION_FIELDS) {
    const change = changes[field];
    if (!change) continue;
    if (normalizeStored(field, current[field]) !== change.from) return true;
  }
  return false;
}

export function changesToUpdateData(changes: SuggestionChanges): Partial<Record<SuggestionField, SuggestionValue>> {
  const data: Partial<Record<SuggestionField, SuggestionValue>> = {};
  for (const field of SUGGESTION_FIELDS) {
    const change = changes[field];
    if (change) data[field] = change.to;
  }
  return data;
}

/**
 * Reads `changes` back out of the JSON column, dropping anything that is not a template field
 * with a `{ from, to }` shape. The column is JSON, so a row written by an older version — or by
 * anything else — can never widen what an accept is allowed to write.
 */
export function parseSuggestionChanges(raw: unknown): SuggestionChanges {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const changes: SuggestionChanges = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!FIELD_SET.has(key)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const { from, to } = value as { from?: unknown; to?: unknown };
    const ok = (v: unknown) => v === null || typeof v === 'string';
    if (!ok(from) || !ok(to)) continue;
    changes[key as SuggestionField] = { from: (from ?? null) as SuggestionValue, to: (to ?? null) as SuggestionValue };
  }
  return changes;
}
