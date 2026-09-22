import { buildMrDescription, mergeRequestTitle } from './mr-description';

describe('merge request description', () => {
  it('lists the edited file and the linked cases', () => {
    expect(buildMrDescription(null, 'e2e/a.spec.ts', ['TC-AUTH-001'])).toBe(
      [
        'Test changes made in the Ejad test case tool.',
        '',
        '**Edited files**',
        '- `e2e/a.spec.ts`',
        '',
        '**Linked test cases**',
        '- TC-AUTH-001',
      ].join('\n'),
    );
  });

  it('merges with the previous description without duplicates', () => {
    const previous = buildMrDescription(null, 'e2e/b.spec.ts', ['TC-CART-001']);
    const next = buildMrDescription(previous, 'e2e/a.spec.ts', ['TC-AUTH-001', 'TC-CART-001']);
    expect(next).toContain('**Edited files**\n- `e2e/a.spec.ts`\n- `e2e/b.spec.ts`\n\n');
    expect(next.endsWith('**Linked test cases**\n- TC-AUTH-001\n- TC-CART-001')).toBe(true);
  });

  it('ignores hand-written descriptions and shows "none" without cases', () => {
    const next = buildMrDescription('Hand-written text\n- `not/a/list.ts`', 'e2e/a.spec.ts', []);
    expect(next).toContain('**Edited files**\n- `e2e/a.spec.ts`\n\n');
    expect(next.endsWith('**Linked test cases**\n- none')).toBe(true);
    expect(mergeRequestTitle('  Login fixes ')).toBe('Tests: Login fixes');
  });
});
