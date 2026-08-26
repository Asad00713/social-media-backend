import {
  reconcile,
  shouldSyncChannel,
  SYNC_MIN_INTERVAL_MS,
} from './whatsapp-templates.service';

const meta = (id: string, status = 'APPROVED') => ({
  metaTemplateId: id,
  name: `t_${id}`,
  language: 'en_US',
  category: 'UTILITY',
  status,
  components: [],
});

describe('reconcile', () => {
  it('inserts templates Meta has and we do not', () => {
    const r = reconcile([], [meta('1'), meta('2')]);
    expect(r.toInsert.map((x) => x.metaTemplateId)).toEqual(['1', '2']);
    expect(r.toUpdate).toEqual([]);
    expect(r.toDeleteIds).toEqual([]);
  });

  it('updates templates both sides have', () => {
    const existing = [{ id: 'row-1', metaTemplateId: '1', status: 'PENDING' }];
    const r = reconcile(existing, [meta('1', 'APPROVED')]);
    expect(r.toInsert).toEqual([]);
    expect(r.toUpdate).toHaveLength(1);
    expect(r.toUpdate[0].id).toBe('row-1');
    expect(r.toUpdate[0].row.status).toBe('APPROVED');
    expect(r.toDeleteIds).toEqual([]);
  });

  it('prunes rows Meta no longer has', () => {
    const existing = [
      { id: 'row-1', metaTemplateId: '1', status: 'APPROVED' },
      { id: 'row-2', metaTemplateId: '2', status: 'APPROVED' },
    ];
    const r = reconcile(existing, [meta('1')]);
    expect(r.toDeleteIds).toEqual(['row-2']);
  });

  it('handles all three operations at once', () => {
    const existing = [
      { id: 'row-1', metaTemplateId: '1', status: 'PENDING' },
      { id: 'row-gone', metaTemplateId: '99', status: 'APPROVED' },
    ];
    const r = reconcile(existing, [meta('1', 'APPROVED'), meta('2')]);
    expect(r.toInsert.map((x) => x.metaTemplateId)).toEqual(['2']);
    expect(r.toUpdate.map((x) => x.id)).toEqual(['row-1']);
    expect(r.toDeleteIds).toEqual(['row-gone']);
  });

  it('prunes everything when Meta returns nothing', () => {
    const existing = [{ id: 'row-1', metaTemplateId: '1', status: 'APPROVED' }];
    const r = reconcile(existing, []);
    expect(r.toDeleteIds).toEqual(['row-1']);
    expect(r.toInsert).toEqual([]);
  });

  it('is a no-op when both sides already agree', () => {
    const existing = [{ id: 'row-1', metaTemplateId: '1', status: 'APPROVED' }];
    const r = reconcile(existing, [meta('1', 'APPROVED')]);
    expect(r.toInsert).toEqual([]);
    expect(r.toDeleteIds).toEqual([]);
    // Still emitted as an update: components or category may have changed even
    // when status did not, and re-writing is cheaper than diffing every field.
    expect(r.toUpdate).toHaveLength(1);
  });
});

describe('shouldSyncChannel', () => {
  const now = new Date('2026-08-26T12:00:00Z');

  it('syncs a channel that has never synced', () => {
    expect(shouldSyncChannel(null, now)).toBe(true);
  });

  it('skips a channel synced moments ago', () => {
    const justNow = new Date(now.getTime() - 30_000);
    expect(shouldSyncChannel(justNow, now)).toBe(false);
  });

  it('syncs again once the interval has passed', () => {
    const stale = new Date(now.getTime() - SYNC_MIN_INTERVAL_MS - 1);
    expect(shouldSyncChannel(stale, now)).toBe(true);
  });

  it('syncs at exactly the interval boundary', () => {
    const boundary = new Date(now.getTime() - SYNC_MIN_INTERVAL_MS);
    expect(shouldSyncChannel(boundary, now)).toBe(true);
  });

  it('force overrides a fresh sync', () => {
    const justNow = new Date(now.getTime() - 30_000);
    expect(shouldSyncChannel(justNow, now, true)).toBe(true);
  });
});
