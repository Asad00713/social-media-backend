import { INBOX_ITEM_TYPES, inboxItems } from './inbox.schema';

describe('inbox schema — mentions + hide', () => {
  it('includes the mention item type', () => {
    expect(INBOX_ITEM_TYPES).toContain('mention');
  });
  it('has an isHidden column', () => {
    expect(inboxItems.isHidden).toBeDefined();
  });
});
