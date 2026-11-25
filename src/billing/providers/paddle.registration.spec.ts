import * as fs from 'fs';
import * as path from 'path';

/**
 * The Paddle adapter is actually WIRED, not merely written.
 *
 * A source-level check rather than a Nest container boot: `BillingModule`
 * pulls in Stripe, Drizzle, email, notifications and the queue, so booting it
 * here would need a database and a Redis before it could tell us anything
 * about one registration line.
 *
 * This exists because an adapter that compiles and passes its own 41 tests is
 * still dead code until something calls it — the shape that let
 * `workspacePurge` ship unreachable with its unit tests green. The registry
 * builds its map from `register()` calls in `BillingModule`'s factory, so a
 * missing line there means `adapterFor` throws "No adapter is registered for
 * provider paddle" at the first customer who tries to pay, and nothing before
 * that moment would have said so.
 */

const MODULE = path.join(__dirname, '..', 'billing.module.ts');
const SCHEMA = path.join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'schema',
  'billing.schema.ts',
);

/** The module source with comment lines stripped. */
function moduleSource(): string {
  const raw = fs.readFileSync(MODULE, 'utf8');
  return raw
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

describe('Paddle registration', () => {
  // Comments are stripped first: an earlier audit on this repo passed against
  // a mutation because the name it matched appeared in the explanatory comment
  // the mutation had just left behind.
  const src = moduleSource();

  it('finds the module source (the reader is not silently empty)', () => {
    expect(src.length).toBeGreaterThan(500);
  });

  it('imports the adapter', () => {
    expect(src).toMatch(/import\s*\{\s*PaddleAdapter\s*\}/);
  });

  it('provides the adapter and its client', () => {
    // Without the client in `providers`, Nest cannot construct the adapter and
    // the failure is at boot rather than at a test.
    expect(src).toContain('PaddleClient');
    expect(src).toContain('PaddleAdapter');
  });

  it('REGISTERS the adapter with the registry', () => {
    // The one line that makes the other 41 tests matter.
    expect(src).toMatch(/registry\.register\(\s*paddle\s*\)/);
  });

  it('injects the adapter into the registration factory', () => {
    // `register(paddle)` without `PaddleAdapter` in `inject` is a runtime
    // undefined, not a compile error.
    const factory = src.slice(
      src.indexOf('PROVIDER_ADAPTER_REGISTRATION'),
      src.indexOf('@Module('),
    );
    expect(factory).toMatch(/inject:\s*\[[^\]]*PaddleAdapter/s);
    expect(factory).toMatch(/paddle:\s*PaddleAdapter/);
  });

  it('keeps the other two providers registered', () => {
    // A registration edit that dropped one would send those customers'
    // payments nowhere.
    expect(src).toMatch(/registry\.register\(\s*stripe\s*\)/);
    expect(src).toMatch(/registry\.register\(\s*lemonsqueezy\s*\)/);
  });

  it('has paddle in PAYMENT_PROVIDERS, so BILLING_PROVIDER accepts it', () => {
    // `configuredProvider()` validates the env var against this list and
    // throws for anything else, so a missing entry makes the provider
    // unselectable however well the adapter works.
    const schema = fs.readFileSync(SCHEMA, 'utf8');
    const list = schema.slice(
      schema.indexOf('PAYMENT_PROVIDERS = ['),
      schema.indexOf('] as const'),
    );
    expect(list).toContain("'paddle'");
    expect(list).toContain("'stripe'");
    expect(list).toContain("'lemonsqueezy'");
  });
});
