import { ProviderRegistryService } from './provider-registry.service';

function makeRegistry(rows: Record<string, unknown>[]) {
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(rows),
        }),
        where: jest.fn().mockResolvedValue(rows),
      }),
    }),
  };
  const stripeAdapter = { name: 'stripe' };
  const lsAdapter = { name: 'lemonsqueezy' };
  const svc = new ProviderRegistryService(db as never);
  svc.register(stripeAdapter as never);
  svc.register(lsAdapter as never);
  return { svc, stripeAdapter, lsAdapter };
}

describe('ProviderRegistryService.adapterFor', () => {
  it('returns the adapter matching the account’s own provider', async () => {
    const { svc, lsAdapter } = makeRegistry([
      { provider: 'lemonsqueezy', isDefault: true },
    ]);
    await expect(svc.adapterFor('user-1')).resolves.toBe(lsAdapter);
  });

  it('returns the configured adapter for a brand-new account', async () => {
    process.env.BILLING_PROVIDER = 'lemonsqueezy';
    const { svc, lsAdapter } = makeRegistry([]);
    await expect(svc.adapterFor('user-new')).resolves.toBe(lsAdapter);
  });

  it('throws if no adapter is registered for the resolved provider', async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest
              .fn()
              .mockResolvedValue([{ provider: 'stripe', isDefault: true }]),
          }),
        }),
      }),
    };
    const svc = new ProviderRegistryService(db as never);
    await expect(svc.adapterFor('user-1')).rejects.toThrow(/stripe/);
  });
});
