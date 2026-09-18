import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';

export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.enableCors({ origin: config.get<string[]>('corsOrigins'), credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
}
