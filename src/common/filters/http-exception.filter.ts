import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { STATUS_CODES } from 'http';

export interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
  details?: unknown;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const body = this.toBody(exception);
    if (body.statusCode >= 500) {
      if (this.isExpectedUpstreamFailure(exception)) {
        // An upstream dependency (e.g. GitLab) failing is expected operational behaviour, not a
        // bug in this service — log it as a one-line warning instead of an error with a stack
        // trace, which is what an unexpected 500 gets below.
        this.logger.warn(body.message);
      } else {
        this.logger.error(exception instanceof Error ? exception.stack : String(exception));
      }
    }
    host.switchToHttp().getResponse().status(body.statusCode).json(body);
  }

  /** An `HttpException` deliberately thrown for a failed upstream call (its `details.source` marks where). */
  private isExpectedUpstreamFailure(exception: unknown): boolean {
    if (!(exception instanceof HttpException)) return false;
    const response = exception.getResponse();
    if (typeof response !== 'object' || response === null) return false;
    const details = (response as { details?: unknown }).details;
    return !!details && typeof details === 'object' && 'source' in details;
  }

  private toBody(exception: unknown): ErrorBody {
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const fallbackError = STATUS_CODES[statusCode] ?? 'Error';
      const response = exception.getResponse();
      if (typeof response === 'string') {
        return { statusCode, error: fallbackError, message: response };
      }
      const r = response as { message?: string | string[]; error?: string; details?: unknown };
      if (Array.isArray(r.message)) {
        return { statusCode, error: r.error ?? fallbackError, message: 'Validation failed', details: r.message };
      }
      return {
        statusCode,
        error: r.error ?? fallbackError,
        message: r.message ?? exception.message,
        ...(r.details !== undefined ? { details: r.details } : {}),
      };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return { statusCode: 409, error: 'Conflict', message: 'A record with the same unique value already exists' };
      }
      if (exception.code === 'P2003') {
        return { statusCode: 409, error: 'Conflict', message: 'The record is referenced by other data' };
      }
      if (exception.code === 'P2025') {
        return { statusCode: 404, error: 'Not Found', message: 'Record not found' };
      }
    }
    if (exception instanceof Prisma.PrismaClientValidationError) {
      // Safety net: input that slipped past the DTOs (e.g. null for a required column).
      return { statusCode: 400, error: 'Bad Request', message: 'Invalid request data' };
    }
    return { statusCode: 500, error: 'Internal Server Error', message: 'Internal server error' };
  }
}
