import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

/** A body over the configured limit; body-parser throws this before any Nest routing runs. */
function isPayloadTooLarge(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { type?: unknown }).type === 'entity.too.large';
}

export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);
  const trustProxy = config.get<boolean | number | string>('trustProxy');
  // Behind a reverse proxy (Dokploy/Traefik) req.ip must come from X-Forwarded-For,
  // otherwise every user shares the proxy's IP and one login rate-limit bucket.
  if (trustProxy !== undefined) app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);
  // Test files up to 1 MB are saved from the web editor as JSON (Express's default limit is 100 kb).
  (app as NestExpressApplication).useBodyParser('json', { limit: '2mb' });
  // A body over that limit throws inside the body parser, before Nest's router (and so its global
  // exception filter) ever sees the request — without this, Express's default handler sends its
  // own bare HTML error page instead of the API's usual JSON error shape.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (!isPayloadTooLarge(err)) {
      next(err);
      return;
    }
    res.status(413).json({ statusCode: 413, error: 'Payload Too Large', message: 'Request body is too large' });
  });
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.enableCors({ origin: config.get<string[]>('corsOrigins'), credentials: true, exposedHeaders: ['Content-Disposition'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
}
