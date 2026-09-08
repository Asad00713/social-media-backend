// src/billing/providers/lemonsqueezy.adapter.spec.ts
import { LemonSqueezyAdapter } from './lemonsqueezy.adapter';

type Row = {
  id: number;
  itemType: string;
  providerSubscriptionId: string;
  providerItemId: string;
};

function fiveRows(): Row[] {
  return [
    { id: 1, itemType: 'BASE_PLAN', providerSubscriptionId: '100', providerItemId: '900' },
    { id: 2, itemType: 'EXTRA_CHANNEL', providerSubscriptionId: '101', providerItemId: '901' },
    { id: 3, itemType: 'EXTRA_MEMBER', providerSubscriptionId: '102', providerItemId: '902' },
    { id: 4, itemType: 'EXTRA_WORKSPACE', providerSubscriptionId: '103', providerItemId: '903' },
    { id: 5, itemType: 'EXTRA_AI_TOKENS', providerSubscriptionId: '104', providerItemId: '904' },
  ];
}

function makeAdapter(rows: Row[], clientOverrides: Record<string, jest.Mock> = {}) {
  const updates: { id: number; set: Record<string, unknown> }[] = [];
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(rows),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockImplementation((set: Record<string, unknown>) => ({
        where: jest.fn().mockImplementation(() => {
          updates.push({ id: -1, set });
          return Promise.resolve(undefined);
        }),
      })),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
        onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
      }),
    }),
  };

  const client = {
    get: jest.fn().mockResolvedValue({ data: { attributes: {} } }),
    post: jest.fn().mockResolvedValue({
      data: { attributes: { url: 'https://ls.test/checkout/abc' } },
    }),
    patch: jest.fn().mockResolvedValue({ data: { attributes: {} } }),
    delete: jest.fn().mockResolvedValue({
      data: { attributes: { status: 'cancelled' } },
    }),
    ...clientOverrides,
  };

  const catalogue = { resolveRef: jest.fn().mockResolvedValue('2100632') };
  const adapter = new LemonSqueezyAdapter(
    db as never,
    client as never,
    catalogue as never,
  );
  return { adapter, client, catalogue, db, updates };
}

describe('LemonSqueezyAdapter.name', () => {
  it('identifies itself as lemonsqueezy', () => {
    const { adapter } = makeAdapter([]);
    expect(adapter.name).toBe('lemonsqueezy');
  });
});

describe('LemonSqueezyAdapter.purchaseAddon', () => {
  // No POST /v1/subscription-items exists, so a NEW add-on can only start at a
  // hosted checkout.
  it('returns a checkout url for an add-on the account does not have', async () => {
    const { adapter } = makeAdapter([
      { id: 1, itemType: 'BASE_PLAN', providerSubscriptionId: '100', providerItemId: '900' },
    ]);
    const result = await adapter.purchaseAddon(1, 'EXTRA_CHANNEL', 2);
    expect(result).toEqual({
      status: 'checkout_required',
      url: 'https://ls.test/checkout/abc',
    });
  });

  // Verified live 2026-09-07: PATCH with invoice_immediately charged PKR 400
  // at once and left renews_at untouched.
  it('updates quantity in place when the add-on already exists', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    const result = await adapter.purchaseAddon(1, 'EXTRA_CHANNEL', 5);
    expect(result).toEqual({ status: 'completed', quantity: 5 });
    expect(client.patch).toHaveBeenCalledWith(
      'subscription-items/901',
      expect.objectContaining({
        data: expect.objectContaining({
          attributes: expect.objectContaining({
            quantity: 5,
            invoice_immediately: true,
          }),
        }),
      }),
    );
  });
});

describe('LemonSqueezyAdapter.changeAddonQuantity', () => {
  it('invoices immediately so the charge is not deferred to renewal', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    await adapter.changeAddonQuantity(1, 'EXTRA_MEMBER', 4);
    expect(client.patch).toHaveBeenCalledWith(
      'subscription-items/902',
      expect.objectContaining({
        data: expect.objectContaining({
          attributes: expect.objectContaining({ invoice_immediately: true }),
        }),
      }),
    );
  });

  it('throws when the account has no such add-on', async () => {
    const { adapter } = makeAdapter([
      { id: 1, itemType: 'BASE_PLAN', providerSubscriptionId: '100', providerItemId: '900' },
    ]);
    await expect(
      adapter.changeAddonQuantity(1, 'EXTRA_CHANNEL', 2),
    ).rejects.toThrow(/EXTRA_CHANNEL/);
  });
});

describe('LemonSqueezyAdapter.removeAddon', () => {
  // An add-on IS a whole subscription here, so removing it means cancelling
  // that subscription, not deleting a line item.
  it('cancels the add-on’s own subscription', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    await adapter.removeAddon(1, 'EXTRA_CHANNEL');
    expect(client.delete).toHaveBeenCalledWith('subscriptions/101');
  });
});

describe('LemonSqueezyAdapter.cancel', () => {
  it('cancels every one of the five subscriptions', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    await adapter.cancel(1, true);
    expect(client.delete).toHaveBeenCalledTimes(5);
  });

  // Load-bearing. If the fan-out breaks midway the customer must still hold
  // the base plan; cancelling it first would end access while add-ons billed.
  it('cancels the base plan LAST', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    await adapter.cancel(1, true);
    const paths = client.delete.mock.calls.map((c: string[]) => c[0]);
    expect(paths[paths.length - 1]).toBe('subscriptions/100');
  });

  it('leaves the base plan alive when an add-on cancel fails midway', async () => {
    const failing = jest
      .fn()
      .mockResolvedValueOnce({ data: { attributes: { status: 'cancelled' } } })
      .mockRejectedValueOnce(new Error('provider 500'));
    const { adapter } = makeAdapter(fiveRows(), { delete: failing });

    await expect(adapter.cancel(1, true)).rejects.toThrow('provider 500');
    const paths = failing.mock.calls.map((c: string[]) => c[0]);
    expect(paths).not.toContain('subscriptions/100');
  });

  // A break midway must leave the database telling the truth about which rows
  // were actually cancelled, so reconciliation can repair it.
  it('records each cancellation as it happens, not after the whole fan-out', async () => {
    const failing = jest
      .fn()
      .mockResolvedValueOnce({ data: { attributes: { status: 'cancelled' } } })
      .mockRejectedValueOnce(new Error('provider 500'));
    const { adapter, db } = makeAdapter(fiveRows(), { delete: failing });

    await expect(adapter.cancel(1, true)).rejects.toThrow();
    expect(db.update).toHaveBeenCalledTimes(1);
  });
});

describe('LemonSqueezyAdapter.pause / resume', () => {
  // behavior 'void', not keep_as_draft: a returning customer must not be
  // handed a stack of back-invoices.
  it('pauses with mode void', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    await adapter.pause(1);
    expect(client.patch).toHaveBeenCalledWith(
      'subscriptions/100',
      expect.objectContaining({
        data: expect.objectContaining({
          attributes: expect.objectContaining({
            pause: { mode: 'void' },
          }),
        }),
      }),
    );
  });

  it('resumes by clearing the pause', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    await adapter.resume(1);
    expect(client.patch).toHaveBeenCalledWith(
      'subscriptions/100',
      expect.objectContaining({
        data: expect.objectContaining({
          attributes: expect.objectContaining({ pause: null }),
        }),
      }),
    );
  });

  it('pauses add-ons too, so nothing keeps billing while paused', async () => {
    const { adapter, client } = makeAdapter(fiveRows());
    await adapter.pause(1);
    expect(client.patch).toHaveBeenCalledTimes(5);
  });
});
