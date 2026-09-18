import { ArgumentsHost, BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { HttpExceptionFilter } from './http-exception.filter';

function run(exception: unknown) {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }), getRequest: () => ({ url: '/api/x' }) }),
  } as unknown as ArgumentsHost;
  new HttpExceptionFilter().catch(exception, host);
  return { status: (status.mock.calls[0] as unknown[])[0], body: (json.mock.calls[0] as unknown[])[0] };
}

describe('HttpExceptionFilter', () => {
  it('formats a Nest HttpException', () => {
    expect(run(new NotFoundException('Project not found'))).toEqual({
      status: 404,
      body: { statusCode: 404, error: 'Not Found', message: 'Project not found' },
    });
  });

  it('turns validation message arrays into details', () => {
    const { status, body } = run(new BadRequestException(['name should not be empty', 'key must be uppercase']));
    expect(status).toBe(400);
    expect(body).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Validation failed',
      details: ['name should not be empty', 'key must be uppercase'],
    });
  });

  it('keeps the message of a ConflictException', () => {
    expect(run(new ConflictException('Run is completed')).body).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 'Run is completed',
    });
  });

  it('formats string-response exceptions such as throttling', () => {
    const { status, body: rawBody } = run(new ThrottlerException());
    const body = rawBody as any;
    expect(status).toBe(429);
    expect(body.error).toBe('Too Many Requests');
    expect(typeof body.message).toBe('string');
  });

  it('maps Prisma unique violations to 409', () => {
    const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
    expect(run(err)).toEqual({
      status: 409,
      body: { statusCode: 409, error: 'Conflict', message: 'A record with the same unique value already exists' },
    });
  });

  it('maps Prisma foreign key violations to 409', () => {
    const err = new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', { code: 'P2003', clientVersion: 'test' });
    expect(run(err)).toEqual({
      status: 409,
      body: { statusCode: 409, error: 'Conflict', message: 'The record is referenced by other data' },
    });
  });

  it('maps Prisma record-not-found to 404', () => {
    const err = new Prisma.PrismaClientKnownRequestError('Not found', { code: 'P2025', clientVersion: 'test' });
    expect(run(err).status).toBe(404);
  });

  it('maps Prisma validation errors (e.g. null for a required column) to 400 without leaking details', () => {
    const err = new Prisma.PrismaClientValidationError('Argument `name` must not be null.', { clientVersion: 'test' });
    expect(run(err)).toEqual({
      status: 400,
      body: { statusCode: 400, error: 'Bad Request', message: 'Invalid request data' },
    });
  });

  it('hides unexpected errors behind a generic 500', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    expect(run(new Error('database password is xyz'))).toEqual({
      status: 500,
      body: { statusCode: 500, error: 'Internal Server Error', message: 'Internal server error' },
    });
  });
});
