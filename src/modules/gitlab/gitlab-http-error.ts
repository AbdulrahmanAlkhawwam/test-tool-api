import { BadGatewayException, HttpException } from '@nestjs/common';
import { STATUS_CODES } from 'http';

/** A failed GitLab call. status 0 means GitLab could not be reached (network error or timeout). */
export class GitlabHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitlabHttpError';
  }
}

/** GitLab error bodies: { message: string | string[] | Record<string, string[]> } or OAuth { error, error_description }. */
export function gitlabErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const b = body as { message?: unknown; error?: unknown; error_description?: unknown };
    const m = b.message;
    if (typeof m === 'string' && m) return m;
    if (Array.isArray(m) && m.length) return m.map(String).join('; ');
    if (m && typeof m === 'object') {
      const parts = Object.entries(m as Record<string, unknown>).map(([key, value]) => {
        const text = Array.isArray(value) ? value.map(String).join(', ') : String(value);
        return key === 'base' ? text : `${key} ${text}`;
      });
      if (parts.length) return parts.join('; ');
    }
    if (typeof b.error_description === 'string' && b.error_description) return b.error_description;
    if (typeof b.error === 'string' && b.error) return b.error;
  }
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 500);
  return `GitLab responded with HTTP ${status}`;
}

/** Passes GitLab's status and message to the client (401 is handled by the caller before this). */
export function toHttpException(error: GitlabHttpError): HttpException {
  if (error.status === 0 || error.status >= 500) {
    return new BadGatewayException({ message: `GitLab request failed: ${error.message}`, details: { source: 'gitlab' } });
  }
  return new HttpException(
    { statusCode: error.status, error: STATUS_CODES[error.status] ?? 'Error', message: error.message, details: { source: 'gitlab' } },
    error.status,
  );
}
