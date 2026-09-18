import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  // Run onModuleDestroy (Prisma disconnect) on SIGTERM from `docker stop` / redeploys.
  app.enableShutdownHooks();

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Ejad Test Cases API')
      .setDescription('Projects, test cases, runs, import/export and reports')
      .setVersion('1.0')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('api/docs', app, document, { swaggerOptions: { persistAuthorization: true } });

  const port = app.get(ConfigService).get<number>('port') ?? 3000;
  await app.listen(port);
}

void bootstrap();
