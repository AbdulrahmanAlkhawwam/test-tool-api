import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);
  const trustProxy = config.get<boolean | number | string>('trustProxy');
  // Behind a reverse proxy (Dokploy/Traefik) req.ip must come from X-Forwarded-For,
  // otherwise every user shares the proxy's IP and one login rate-limit bucket.
  if (trustProxy !== undefined) app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.enableCors({ origin: config.get<string[]>('corsOrigins'), credentials: true, exposedHeaders: ['Content-Disposition'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
}
