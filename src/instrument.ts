import * as Sentry from '@sentry/nestjs';
import { redactTokenUrls } from './logs/redact-token-urls';
import { redactSensitivePath } from './logs/redact-path';
import { sentryRelease } from './common/app-version';

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

/**
 * Redacts the URL and drops everything else a request can carry. Shared by
 * the error and transaction hooks so the two can never drift — a rule applied
 * in only one of them is a rule that leaks through the other.
 */
function scrubRequest(event: {
  // Structural rather than Sentry's own ErrorEvent/TransactionEvent: those
  // are not re-exported from @sentry/nestjs, and only these fields are
  // touched here.
  request?: {
    url?: string;
    query_string?: unknown;
    data?: unknown;
    cookies?: unknown;
    headers?: unknown;
  };
}): void {
  if (!event.request) return;
  if (typeof event.request.url === 'string') {
    event.request.url = scrubUrl(event.request.url);
  }
  delete event.request.query_string;
  delete event.request.data;
  delete event.request.cookies;
  delete event.request.headers;
}

/** Span attributes that quote a URL, and the ones that are pure query data. */
const SPAN_URL_KEYS = [
  'http.url',
  'url.full',
  'url.path',
  'http.target',
  'http.route',
] as const;
const SPAN_DROP_KEYS = ['url.query', 'http.query'] as const;

function scrubSpan(span: {
  data?: Record<string, unknown>;
  description?: string;
}): void {
  // The description is usually "GET /some/path", so it quotes the URL too.
  if (typeof span.description === 'string') {
    span.description = scrubUrl(span.description);
  }
  if (!span.data) return;
  for (const key of SPAN_URL_KEYS) {
    const value = span.data[key];
    if (typeof value === 'string') span.data[key] = scrubUrl(value);
  }
  // A query string is never worth redacting field by field.
  for (const key of SPAN_DROP_KEYS) delete span.data[key];
}

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // Explicit rather than relying on an undefined DSN to disable the SDK.
  enabled: !!process.env.SENTRY_DSN,

  environment: process.env.NODE_ENV ?? 'development',

  // schedura-backend@<version>+<short sha>, so an error names the build that
  // threw it. SENTRY_RELEASE still overrides. See common/app-version.ts.
  release: sentryRelease(),

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
    scrubRequest(event);
    return event;
  },

  /**
   * Transactions carry the URL too — as the transaction name, on the request
   * and on every child span — and are sampled independently of errors, so a
   * token would reach Sentry through tracing even if no error ever fired.
   * Child spans are scrubbed here as well as in `beforeSendSpan`: spans
   * embedded in a transaction envelope do not all pass through that hook.
   */
  beforeSendTransaction(event) {
    if (event.transaction) event.transaction = scrubUrl(event.transaction);
    scrubRequest(event);
    event.spans?.forEach(scrubSpan);
    return event;
  },

  beforeSendSpan(span) {
    scrubSpan(span);
    return span;
  },
});
