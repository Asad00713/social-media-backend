import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import express from 'express';

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

  // Basic-auth gate for Bull Board dashboard. Phase 1: env-driven. Will be
  // upgraded to a proper admin JWT guard when admin pattern is consolidated.
  app.use('/admin/queues', (req: any, res: any, next: any) => {
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

  const port = process.env.PORT ?? 8000;
  await app.listen(port, '0.0.0.0');
  console.log(`Application is running on port ${port}`);
}
bootstrap();
