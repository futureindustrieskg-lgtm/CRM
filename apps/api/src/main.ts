import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody — для проверки подписи уведомлений банка (webhooks/payments).
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.setGlobalPrefix('api/v1');
  app.enableCors({ origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','), credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  // Документация API (ТЗ 5): http://localhost:3000/api/docs
  const config = new DocumentBuilder()
    .setTitle('CRM учебного центра — API')
    .setDescription('REST API для веб-кабинета и мобильных приложений. Заголовок X-Active-Role переключает активную роль.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`API: http://localhost:${port}/api/v1  ·  Swagger: http://localhost:${port}/api/docs`);
}
bootstrap();
