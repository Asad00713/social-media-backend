import * as Sentry from '@sentry/nestjs';
import { redactTokenUrls } from './logs/redact-token-urls';
import { redactSensitivePath } from './logs/redact-path';

/**
 * Sentry initialisation.
 *
 * **This module must be imported before anything else in main.ts.** Sentry
 * instruments libraries by patching them as they load, so anything imported
 * ahead of it — Express, pg, ioredis — is already captured by reference and
 * never traced. The import order in main.ts is load-bearing, not cosmetic.
 *
 * The two redaction helpers it imports are pure string functions with no
 * imports of their own, so pulling them in this early patches nothing.
 *
 * Without `SENTRY_DSN` the SDK initialises disabled: no network calls, no
 * overhead, and the app behaves identically. That is the default for local
 * development and for production until the DSN is set, so this file never
 * needs a key to merge.
 */

/** Strips credentials that live in a URL's own path or query string. */
function scrubUrl(url: string): string {
  return redactTokenUrls(redactSensitivePath(url));
}

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // Explicit rather than relying on an undefined DSN to disable the SDK.
  enabled: !!process.env.SENTRY_DSN,

  environment: process.env.NODE_ENV ?? 'development',

  // 10% of requests carry a performance trace — enough to spot a slow
  // endpoint, far short of the free tier's span quota. Read from env so it
  // can be tuned without a deploy.
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),

  // Do not let Sentry attach IP addresses and headers on its own. What
  // identifies a user here is attached deliberately, in the exception filter,
  // and is ids only.
  sendDefaultPii: false,

  /**
   * `sendDefaultPii: false` withholds IPs and headers, but not the request
   * URL — and some of this app's URLs *are* the credential: a report link, a
   * render token, an email unsubscribe or security link all carry a usable
   * token in the path. Those already get redacted on the way into the
   * `error_logs` table; Sentry is a second destination and needs the same
   * treatment, or a token ends up in a third-party dashboard.
   *
   * Bodies, query strings and cookies are dropped outright rather than
   * redacted. A request body can hold anything — passwords on a login
   * failure, OAuth codes on a callback, post content — and there is no
   * version of it worth the risk of being wrong about.
   */
  beforeSend(event) {
    if (event.request) {
      if (event.request.url) event.request.url = scrubUrl(event.request.url);
      delete event.request.query_string;
      delete event.request.data;
      delete event.request.cookies;
      delete event.request.headers;
    }
    return event;
  },

  /**
   * Transactions carry the URL too — as the transaction name and on the span
   * attributes — and are sampled independently of errors, so a token would
   * reach Sentry through tracing even if no error ever fired.
   */
  beforeSendTransaction(event) {
    if (event.transaction) event.transaction = scrubUrl(event.transaction);
    if (event.request?.url) event.request.url = scrubUrl(event.request.url);
    return event;
  },

  beforeSendSpan(span) {
    for (const key of ['http.url', 'url.full', 'url.path'] as const) {
      const value = span.data?.[key];
      if (typeof value === 'string') span.data[key] = scrubUrl(value);
    }
    return span;
  },
});
