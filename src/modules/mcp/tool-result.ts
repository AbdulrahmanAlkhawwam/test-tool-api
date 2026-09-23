import { HttpException } from '@nestjs/common';

export interface ToolResult {
  // The SDK's own CallToolResult type carries an index signature (it's a passthrough zod object),
  // so a plain `{ content, isError? }` object literal is not structurally assignable to what
  // `registerTool`'s callback must return without one; it does not affect the actual JSON shape,
  // which is exactly `{ content, isError? }` (see the tests below).
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** Every tool answers with one JSON text block (spec §7). */
export function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/**
 * Spec §10: a validation or not-found problem is an MCP *tool* error carrying the API's own
 * message, not a transport error — the AI can read it and fix its call. Anything that is not a
 * deliberate HttpException is an internal failure, so it gets a fixed message: an AI client (and
 * whatever it pastes into a chat) must never see a stack trace or a connection string.
 */
export function toolErrorMessage(e: unknown): string {
  if (e instanceof HttpException) {
    const response = e.getResponse();
    if (typeof response === 'string') return response;
    const r = response as { message?: string | string[]; details?: unknown };
    if (Array.isArray(r.message)) return r.message.join('; ');
    if (typeof r.message === 'string') {
      return Array.isArray(r.details) ? `${r.message}: ${(r.details as unknown[]).join('; ')}` : r.message;
    }
    return e.message;
  }
  return 'The request could not be completed';
}

export function toolError(e: unknown): ToolResult {
  return { content: [{ type: 'text', text: toolErrorMessage(e) }], isError: true };
}

/** Runs a tool body, turning a success into JSON and a failure into a tool error. */
export async function runTool(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return jsonResult(await fn());
  } catch (e) {
    return toolError(e);
  }
}
