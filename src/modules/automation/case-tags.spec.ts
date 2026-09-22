import { extractCaseTags } from './case-tags';

describe('extractCaseTags', () => {
  it('finds tags in titles and tag options, unique and sorted', () => {
    const source = [
      "test('rejects a wrong password @TC-AUTH-002', async () => {});",
      "test('logs in', { tag: ['@TC-AUTH-001', '@smoke'] }, async () => {});",
      '// covered again: @TC-AUTH-002',
    ].join('\n');
    expect(extractCaseTags(source)).toEqual(['TC-AUTH-001', 'TC-AUTH-002']);
  });

  it('ignores text that only looks like a tag', () => {
    expect(extractCaseTags('TC-AUTH-001 @tc-auth-001 @TC-AUTH-abc @TC-AUTH-001x')).toEqual([]);
  });
});
