import { BadRequestException, NotFoundException } from '@nestjs/common';
import { jsonResult, runTool, toolError, toolErrorMessage } from './tool-result';

describe('tool-result', () => {
  it('wraps a value as a single JSON text block', () => {
    const result = jsonResult({ code: 'TC-AUTH-001', ok: true });
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual({ code: 'TC-AUTH-001', ok: true });
  });

  it('turns an API exception into a tool error carrying the API message', () => {
    expect(toolErrorMessage(new NotFoundException('Project not found'))).toBe('Project not found');
    expect(toolErrorMessage(new BadRequestException(['name must be longer', 'priority is invalid']))).toBe(
      'name must be longer; priority is invalid',
    );
    const result = toolError(new NotFoundException('Test case not found'));
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'Test case not found' }] });
  });

  it('never leaks an unexpected error’s details to the AI', async () => {
    expect(toolErrorMessage(new Error('connect ECONNREFUSED 10.0.0.5:5432'))).toBe('The request could not be completed');
    const result = await runTool(async () => {
      throw new Error('secret internals');
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('The request could not be completed');
    expect(await runTool(async () => ({ ok: true }))).toEqual({ content: [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }] });
  });
});
