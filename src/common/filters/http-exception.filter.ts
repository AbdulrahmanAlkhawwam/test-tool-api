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
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }
    host.switchToHttp().getResponse().status(body.statusCode).json(body);
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
