import { ProviderRegistryService } from './provider-registry.service';

function makeDb(rows: Record<string, unknown>[]) {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(rows),
        }),
        where: jest.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

describe('ProviderRegistryService.configuredProvider', () => {
  const OLD = process.env.BILLING_PROVIDER;
  afterEach(() => {
    process.env.BILLING_PROVIDER = OLD;
  });

  it('reads BILLING_PROVIDER', () => {
    process.env.BILLING_PROVIDER = 'stripe';
    const svc = new ProviderRegistryService(makeDb([]) as never);
    expect(svc.configuredProvider()).toBe('stripe');
  });

  it('defaults to lemonsqueezy when unset', () => {
    delete process.env.BILLING_PROVIDER;
    const svc = new ProviderRegistryService(makeDb([]) as never);
    expect(svc.configuredProvider()).toBe('lemonsqueezy');
  });

  // A typo must not silently route real money somewhere unintended.
  it('throws on an unrecognised value rather than guessing', () => {
    process.env.BILLING_PROVIDER = 'strpe';
    const svc = new ProviderRegistryService(makeDb([]) as never);
    expect(() => svc.configuredProvider()).toThrow(/strpe/);
  });
});

describe('ProviderRegistryService.providerForUser', () => {
  it('uses the account’s own default row, not the env var', async () => {
    process.env.BILLING_PROVIDER = 'stripe';
    const db = makeDb([{ provider: 'lemonsqueezy', isDefault: true }]);
    const svc = new ProviderRegistryService(db as never);
    // An existing customer must never change provider implicitly.
    await expect(svc.providerForUser('user-1')).resolves.toBe('lemonsqueezy');
  });

  it('falls back to the configured provider for a brand-new account', async () => {
    process.env.BILLING_PROVIDER = 'lemonsqueezy';
    const svc = new ProviderRegistryService(makeDb([]) as never);
    await expect(svc.providerForUser('user-new')).resolves.toBe('lemonsqueezy');
  });

  // Falling back to Stripe here would reintroduce exactly the silent-Stripe
  // problem this whole design exists to prevent.
  it('does NOT hardcode stripe as the fallback', async () => {
    process.env.BILLING_PROVIDER = 'lemonsqueezy';
    const svc = new ProviderRegistryService(makeDb([]) as never);
    await expect(svc.providerForUser('user-new')).resolves.not.toBe('stripe');
  });
});

describe('ProviderRegistryService.defaultProviderFor', () => {
  it('returns the default provider for a subscription', async () => {
    const db = makeDb([{ provider: 'lemonsqueezy', isDefault: true }]);
    const svc = new ProviderRegistryService(db as never);
    await expect(svc.defaultProviderFor(1)).resolves.toBe('lemonsqueezy');
  });

  // Null, not a guess: the guard uses this, and a guess would either block a
  // legitimate call or wave through the one it exists to catch.
  it('returns null when the subscription has no provider rows', async () => {
    const svc = new ProviderRegistryService(makeDb([]) as never);
    await expect(svc.defaultProviderFor(1)).resolves.toBeNull();
  });

  it('ignores non-default rows during a migration window', async () => {
    const db = makeDb([
      { provider: 'lemonsqueezy', isDefault: false },
      { provider: 'stripe', isDefault: true },
    ]);
    const svc = new ProviderRegistryService(db as never);
    await expect(svc.defaultProviderFor(1)).resolves.toBe('stripe');
  });
});
