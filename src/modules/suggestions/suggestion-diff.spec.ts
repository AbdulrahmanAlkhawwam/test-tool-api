import {
  buildSuggestionChanges,
  changesToUpdateData,
  isSuggestionStale,
  parseSuggestionChanges,
  SUGGESTION_FIELDS,
} from './suggestion-diff';

const current = {
  name: 'Login with valid email',
  description: 'Old description',
  preconditions: null,
  steps: '1. Open Login',
  testData: null,
  expectedResult: 'Dashboard opens',
  priority: 'MEDIUM',
  notes: null,
};

describe('buildSuggestionChanges', () => {
  it('keeps only the fields that really change, as from/to pairs', () => {
    const changes = buildSuggestionChanges(current, {
      name: 'Login with valid email',
      steps: '1. Open Login\n2. Submit',
      testData: 'tester@ejad.test / Passw0rd!',
    });
    expect(changes).toEqual({
      steps: { from: '1. Open Login', to: '1. Open Login\n2. Submit' },
      testData: { from: null, to: 'tester@ejad.test / Passw0rd!' },
    });
    expect(changesToUpdateData(changes)).toEqual({
      steps: '1. Open Login\n2. Submit',
      testData: 'tester@ejad.test / Passw0rd!',
    });
  });

  it('returns nothing when the proposal matches the case or is empty', () => {
    expect(buildSuggestionChanges(current, {})).toEqual({});
    expect(buildSuggestionChanges(current, { name: current.name, priority: 'MEDIUM' })).toEqual({});
    expect(buildSuggestionChanges(current, { preconditions: undefined })).toEqual({});
  });

  it('ignores anything outside the template, both on the way in and on the way out', () => {
    const changes = buildSuggestionChanges(current, {
      id: 'other-id',
      code: 'TC-AUTH-999',
      moduleId: 'other-module',
      moduleCode: 'CART',
      reviewState: 'APPROVED',
      createdVia: 'WEB',
      projectId: 'other-project',
      deletedAt: null,
      notes: 'Keep an eye on this',
    } as never);
    expect(changes).toEqual({ notes: { from: null, to: 'Keep an eye on this' } });

    expect(
      parseSuggestionChanges({
        notes: { from: null, to: 'ok' },
        reviewState: { from: 'AI_DRAFT', to: 'APPROVED' },
        code: { from: 'TC-AUTH-001', to: 'TC-AUTH-002' },
        steps: 'not-a-change-object',
      }),
    ).toEqual({ notes: { from: null, to: 'ok' } });
    expect(parseSuggestionChanges(null)).toEqual({});
    expect(parseSuggestionChanges('nonsense')).toEqual({});
  });

  it('treats an empty string and null as the same cleared value for optional text', () => {
    expect(buildSuggestionChanges(current, { preconditions: '' })).toEqual({});
    expect(buildSuggestionChanges({ ...current, notes: '' }, { notes: null })).toEqual({});
    expect(buildSuggestionChanges(current, { description: '' })).toEqual({
      description: { from: 'Old description', to: null },
    });
  });

  it('records a priority change but never blanks the name', () => {
    expect(buildSuggestionChanges(current, { priority: 'HIGH' })).toEqual({ priority: { from: 'MEDIUM', to: 'HIGH' } });
    expect(buildSuggestionChanges(current, { name: '' })).toEqual({});
    expect(buildSuggestionChanges(current, { name: null })).toEqual({});
    expect(buildSuggestionChanges(current, { priority: '' })).toEqual({});
  });

  it('covers exactly the eight template fields', () => {
    expect([...SUGGESTION_FIELDS]).toEqual([
      'name', 'description', 'preconditions', 'steps', 'testData', 'expectedResult', 'priority', 'notes',
    ]);
  });
});

describe('isSuggestionStale', () => {
  const changes = buildSuggestionChanges(current, { steps: 'new steps', notes: 'new notes' });

  it('is false while every field the suggestion touches still holds its original value', () => {
    expect(isSuggestionStale(changes, current)).toBe(false);
    expect(isSuggestionStale({}, current)).toBe(false);
  });

  it('is true when a field the suggestion touches has moved on', () => {
    expect(isSuggestionStale(changes, { ...current, steps: 'a human rewrote these' })).toBe(true);
    expect(isSuggestionStale(changes, { ...current, notes: 'a human added a note' })).toBe(true);
    expect(isSuggestionStale(changes, { ...current, steps: null })).toBe(true);
  });

  it('is false when a field the suggestion does not touch has changed', () => {
    expect(isSuggestionStale(changes, { ...current, name: 'Renamed', priority: 'HIGH', description: 'New' })).toBe(false);
  });
});
