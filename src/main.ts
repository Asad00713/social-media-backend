// MUST be first: Sentry instruments libraries as they load, so anything
// imported before this is captured by reference and never traced.
import './instrument';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import {
  processRole,
  servesHttp,
} from './common/process-role/process-role';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppLoggerService } from './logs/app-logger.service';
import { LogWriterService } from './logs/log-writer.service';
import { AllExceptionsFilter } from './logs/all-exceptions.filter';
import { REQUEST_ID_HEADER, requestIdMiddleware } from './logs/request-context';
import { SAMPLE_ASSET_ROUTE } from './media-library/samples/sample-content';
import { sampleAssetsMiddleware } from './media-library/samples/sample-assets';
import { APP_VERSION_HEADER, appVersionMiddleware } from './common/app-version';
import { bodyShapeMiddleware } from './common/validation/body-shape.middleware';

/**
 * The ceiling for a JSON or form body. See the note in `bootstrap` for why
 * this number and why it is set through `useBodyParser`.
 */
const BODY_LIMIT = '256kb';

/**
 * `POST /media/upload/base64` takes a file inline as base64, so it needs a
 * ceiling of its own. Base64 inflates by about a third, so this admits a file
 * of roughly 15MB.
 */
const UPLOAD_BASE64_ROUTE = '/media/upload/base64';
const UPLOAD_BASE64_LIMIT = '20mb';

async function bootstrap() {
  // `rawBody: true` makes Nest buffer the unparsed request body onto
  // `req.rawBody` (alongside the normal parsed JSON). Stripe webhook signature
  // verification needs the exact bytes Stripe signed — see
  // BillingController.handleStripeWebhook.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // Every request gets an id first, before any parser or route, so even a
  // request that fails in a parser answers with an X-Request-Id header. The
  // AsyncLocalStorage scope opens later, in LogsModule. See request-context.ts.
  app.use(requestIdMiddleware);

  // X-App-Version on every response: which build answered. Cheap, and it
  // turns "is the fix deployed yet?" into a header lookup.
  app.use(appVersionMiddleware);

  // Without this, SIGTERM kills the process mid-job on every deploy: a post
  // being published is left stranded in `publishing` forever, because the
  // processor skips non-`scheduled` rows and manual retry refuses that state.
  //
  // These hooks were enabled once before and reverted the same day, because
  // Nest runs the hooks *within* a shutdown phase through Promise.all — so
  // closing Redis in the same phase that BullMQ closes its workers was a race.
  // The phases themselves are sequential and awaited, so the ordering now
  // comes from the phase split instead:
  //
  //   onModuleDestroy → beforeApplicationShutdown → dispose → onApplicationShutdown
  //                     └ WorkerDrainService:               └ Redis .quit(),
  //                       every BullMQ worker closed          Postgres pool.end()
  //
  // By the time any connection closes, no job is still running.
  //
  // How much of that drain actually completes is Railway's call: its draining
  // window is what decides when SIGKILL lands. See
  // docs/graceful-shutdown-and-health.md.
  app.enableShutdownHooks();

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
      // `.filter(Boolean)` does not narrow `string | undefined` away in
      // TypeScript, and typing the app as NestExpressApplication makes
      // `enableCors` strict enough to say so. Same runtime behaviour.
    ].filter((o): o is string => Boolean(o)),
    credentials: true,
    // The frontend reads the PDF file name from Content-Disposition, and an
    // error's id from X-Request-Id ("Copy error ID" on an error toast).
    exposedHeaders: [
      'Content-Disposition',
      REQUEST_ID_HEADER,
      APP_VERSION_HEADER,
    ],
  });

  // Slack Events API: capture raw body BEFORE the global JSON parser so that
  // HMAC-SHA256 signature verification has the exact bytes Slack signed.
  // This middleware matches only the Slack events endpoint; all other routes
  // continue to receive parsed JSON as usual.
  app.use('/webhooks/slack/events', express.raw({ type: 'application/json' }));

  // Request body ceilings.
  //
  // The JSON parser was running with a 100kb limit nobody chose: Nest's
  // adapter installs `express.json()` with no `limit`, so the number was
  // whatever body-parser happened to default to — a ceiling in front of every
  // route that moves on a dependency bump.
  //
  // `useBodyParser` rather than a bare `app.use(express.json(...))`, for two
  // reasons that a probe made plain:
  //
  //   1. ONLY THE FIRST PARSER TO READ THE BODY COUNTS. A second
  //      `express.json()` with a smaller limit is dead code — the body is
  //      already parsed, so the new limit never applies. Measured: first=1mb
  //      + second=256kb accepts a 300kb body (200), while first=100kb refuses
  //      it (413). The limit has to be set on the parser that actually runs.
  //   2. This is the API that keeps `rawBody`. Both the Stripe and the
  //      LemonSqueezy webhooks verify their signature over `req.rawBody`
  //      (billing.controller.ts), and a parser registered by hand would not
  //      populate it — signature verification would fail for both providers,
  //      i.e. a billing outage. `useBodyParser` passes the app's `rawBody`
  //      option through to the parser's `verify` hook.
  //
  // Nest registers its own parsers inside `app.init()`, which runs on
  // `listen()` — after this function — and skips a parser already applied.
  // So these calls come first and are the ones that govern.
  //
  // 256kb, because a legitimate post is genuinely large: one post fans out to
  // per-platform captions and the platforms' own caps add up (Facebook alone
  // allows 63,206 characters). Summing every platform's cap plus ten media
  // entries each puts the worst-case REAL body near 242kb, so a tighter limit
  // would reject posts the composer invites people to write. Bulk routes are
  // nowhere near it — `ArrayMaxSize(500)` UUIDs is about 19kb.
  //
  // Multipart uploads (`upload/file`, 100MB) never reach these parsers;
  // multer reads those, with its own `limits.fileSize`.
  //
  // `upload/base64` is the one route that legitimately carries a whole file
  // inline, so a post-sized ceiling would disable it. It is registered BEFORE
  // the global parsers because the first parser to read the body wins, and it
  // sets `rawBody` itself the same way Nest's does — this path is scoped to
  // one route, so it cannot affect the webhook routes, but keeping the shape
  // identical means nothing downstream has to care which parser ran.
  //
  // No client in any of our repos calls it today; the route is live and
  // reachable, so it gets a limit that fits its job rather than one that
  // silently breaks it.
  app.use(
    UPLOAD_BASE64_ROUTE,
    express.json({
      limit: UPLOAD_BASE64_LIMIT,
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useBodyParser('urlencoded', { extended: true, limit: BODY_LIMIT });

  // Depth/size guard on the parsed body, before anything recurses over it.
  // Must run after the parsers above and before the global ValidationPipe:
  // class-transformer's `plainToInstance` recurses, so a deep body overflows
  // the stack there rather than failing validation. See the middleware.
  app.use(bodyShapeMiddleware());

  app.use(cookieParser());

  // The Library's bundled sample images (seeded into every new workspace):
  // public, immutable-cached, readable cross-origin. Plain express static,
  // ahead of Nest's guarded routes, because platforms fetch a published
  // post's media without our auth.
  app.use(SAMPLE_ASSET_ROUTE, sampleAssetsMiddleware());

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

  // A `worker` process still LISTENS -- Railway's healthcheck has to reach
  // it, and a container that never binds a port is treated as a failed
  // deploy and restarted forever. What it must not do is serve ordinary
  // API traffic: that is the whole point of the split, since a request
  // answered here would again be queued behind a publish on this event
  // loop.
  //
  // Registered as middleware rather than by dropping controllers so the
  // health routes keep working unchanged, and so a misrouted request
  // fails loudly with 404 instead of being served quietly.
  const role = processRole();
  if (!servesHttp(role)) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.path === '/health' || req.path.startsWith('/health/')) {
        return next();
      }
      res.status(404).json({
        statusCode: 404,
        error: 'Not Found',
        message: 'This process serves background jobs only.',
      });
    });
  }

  const port = process.env.PORT ?? 8000;
  await app.listen(port, '0.0.0.0');
  console.log(
    `Application is running on port ${port} (role=${role}, http=${
      servesHttp(role) ? 'all routes' : 'health only'
    })`,
  );
}
bootstrap();
