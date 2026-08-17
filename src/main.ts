import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import express from 'express';
import { AppLoggerService } from './logs/app-logger.service';
import { LogWriterService } from './logs/log-writer.service';
import { AllExceptionsFilter } from './logs/all-exceptions.filter';

async function bootstrap() {
  // `rawBody: true` makes Nest buffer the unparsed request body onto
  // `req.rawBody` (alongside the normal parsed JSON). Stripe webhook signature
  // verification needs the exact bytes Stripe signed — see
  // BillingController.handleStripeWebhook.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.enableCors({
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      // schedura-admin, the internal admin dashboard.
      'http://localhost:3003',
      'http://localhost:3010',
      'https://e36d-154-81-235-176.ngrok-free.app',
      process.env.APP_URL,
      process.env.FRONTEND_URL,
      process.env.ADMIN_URL,
    ].filter(Boolean),
    credentials: true,
  });

  // Slack Events API: capture raw body BEFORE the global JSON parser so that
  // HMAC-SHA256 signature verification has the exact bytes Slack signed.
  // This middleware matches only the Slack events endpoint; all other routes
  // continue to receive parsed JSON as usual.
  app.use('/webhooks/slack/events', express.raw({ type: 'application/json' }));

  app.use(cookieParser());

  // Basic-auth gate for the Bull Board dashboard. Scoped to '/admin/bull-board'
  // — NOT '/admin/queues', which is where the JWT-guarded admin queue API lives.
  // Gating that prefix here put the whole queue API behind basic auth and out of
  // reach of the admin dashboard. The Nest routes carry their own super-admin
  // guard; only Bull Board's own UI needs this env-driven gate.
  app.use('/admin/bull-board', (req: any, res: any, next: any) => {
    const auth = (req.headers.authorization as string) ?? '';
    const user = process.env.QUEUE_ADMIN_USER ?? 'admin';
    const pass = process.env.QUEUE_ADMIN_PASSWORD ?? 'change-me';
    const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    if (auth !== expected) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Queue Admin"');
      return res.status(401).send('Unauthorized');
    }
    next();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Route error/warn logs to Postgres (console behaviour unchanged), and catch
  // unhandled exceptions into the same table without altering the client
  // response. The writer is injected into the logger after it's resolved,
  // since useLogger runs before we pull providers from the container.
  const appLogger = app.get(AppLoggerService);
  appLogger.setWriter(app.get(LogWriterService));
  app.useLogger(appLogger);
  app.useGlobalFilters(app.get(AllExceptionsFilter));

  const port = process.env.PORT ?? 8000;
  await app.listen(port, '0.0.0.0');
  console.log(`Application is running on port ${port}`);
}
bootstrap();
