import * as fs from 'fs';
import * as path from 'path';

/**
 * Provider-specific calls must stay inside the adapters.
 *
 * This is the layer that protects work done long after the abstraction was
 * built. A new feature that reaches for `stripeService.something` in a service
 * would compile, pass its own tests, and silently bill Lemon Squeezy customers
 * through Stripe. This test fails instead.
 */

const SRC = path.join(__dirname, '..', '..');

/** Files allowed to name a provider directly. */
const ALLOWED = [
  path.join('billing', 'providers'),
  path.join('stripe', 'stripe.service.ts'),
  path.join('stripe', 'stripe.module.ts'),
  path.join('stripe', 'stripe-guard.util.ts'),
  // Webhook + invoice services still speak Stripe's payload types; they are
  // migrated in a later effort and are listed here so the boundary is explicit
  // rather than accidental.
  path.join('billing', 'services', 'webhook.service.ts'),
  path.join('billing', 'services', 'lemonsqueezy-webhook.service.ts'),
  path.join('billing', 'services', 'invoice.service.ts'),
  path.join('billing', 'services', 'invoice-sync.util.ts'),
  path.join('billing', 'services', 'subscription-sync.util.ts'),
  path.join('billing', 'services', 'payment-method.service.ts'),
  path.join('billing', 'services', 'customer.service.ts'),
  // The Stripe webhook ROUTE. `constructWebhookEvent` verifies a Stripe
  // webhook signature on `/webhooks/stripe`, a Stripe-only endpoint — there is
  // nothing to route, because the provider is already known from the URL.
  // Lemon Squeezy's webhook has its own route and its own signature check.
  path.join('billing', 'billing.controller.ts'),
  path.join('drizzle', 'seeds'),
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts'))
      out.push(full);
  }
  return out;
}

function isAllowed(file: string): boolean {
  return ALLOWED.some((a) => file.includes(a));
}

describe('provider isolation', () => {
  const files = walk(SRC).filter((f) => !isAllowed(f));

  it('finds source files to check (the walker is not silently empty)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  // Passing as of Task 11, which routed addon/plan-change/subscription through
  // the registry. It ran as `it.failing` from Task 7 until then, so the day it
  // started passing was visible rather than silently arriving.
  it('has no stripeService call outside the adapters', () => {
    const offenders = files.filter((f) =>
      /stripeService\./.test(fs.readFileSync(f, 'utf8')),
    );
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('has no Lemon Squeezy API call outside the adapters', () => {
    const offenders = files.filter((f) =>
      /api\.lemonsqueezy\.com|LEMONSQUEEZY_API_KEY/.test(
        fs.readFileSync(f, 'utf8'),
      ),
    );
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('has no Paddle API call outside the adapters', () => {
    // Added with the adapter, not after it. The two rules above were written
    // once their providers had already leaked; this one exists before Paddle
    // has a second caller, so the boundary is held from the start.
    //
    // The host is matched as well as the key name because Paddle's sandbox
    // and live hosts differ: a stray `sandbox-api.paddle.com` anywhere
    // outside this folder is the PINTEREST_USE_SANDBOX shape all over again.
    const offenders = files.filter((f) =>
      /api\.paddle\.com|PADDLE_API_KEY|PADDLE_API_BASE/.test(
        fs.readFileSync(f, 'utf8'),
      ),
    );
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});
