import { NotFoundException } from '@nestjs/common';

const selectChain = { rows: [] as any[] };
jest.mock('../../drizzle/db', () => {
  const chain: any = {
    select: jest.fn(() => chain),
    from: jest.fn(() => chain),
    leftJoin: jest.fn(() => chain),
    where: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    limit: jest.fn(() => Promise.resolve(selectChain.rows)),
  };
  return { db: chain };
});

import { InvoiceService } from './invoice.service';

const invoice = {
  id: 5,
  subscriptionId: 9,
  stripeInvoiceId: 'in_1',
  invoicePdfUrl: 'https://pdf/x',
  subtotalCents: 0,
  taxCents: 0,
  totalCents: 0,
  currency: 'usd',
  status: 'paid',
  periodStart: null,
  periodEnd: null,
  paidAt: null,
  hostedInvoiceUrl: null,
  createdAt: new Date(),
};

describe('InvoiceService invoice access', () => {
  const svc = new InvoiceService({} as any, {} as any);

  it('PDF: owner of the subscription gets the url', async () => {
    selectChain.rows = [{ invoice, ownerId: 'owner' }];
    await expect(
      svc.getInvoicePdfUrl(5, { userId: 'owner', role: 'USER' }),
    ).resolves.toBe('https://pdf/x');
  });

  it('PDF: another user gets NotFound', async () => {
    selectChain.rows = [{ invoice, ownerId: 'owner' }];
    await expect(
      svc.getInvoicePdfUrl(5, { userId: 'stranger', role: 'USER' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('PDF: super admin gets the url', async () => {
    selectChain.rows = [{ invoice, ownerId: 'owner' }];
    await expect(
      svc.getInvoicePdfUrl(5, { userId: 'sa', role: 'SUPER_ADMIN' }),
    ).resolves.toBe('https://pdf/x');
  });

  it('PDF: an invoice with no subscription is hidden from regular users', async () => {
    selectChain.rows = [{ invoice, ownerId: null }];
    await expect(
      svc.getInvoicePdfUrl(5, { userId: 'owner', role: 'USER' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('missing invoice is NotFound', async () => {
    selectChain.rows = [];
    await expect(
      svc.getInvoiceDetails(404, { userId: 'owner', role: 'USER' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('details: another user gets NotFound', async () => {
    selectChain.rows = [{ invoice, ownerId: 'owner' }];
    await expect(
      svc.getInvoiceDetails(5, { userId: 'stranger', role: 'USER' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
