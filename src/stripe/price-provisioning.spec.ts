import {
  planLookupKey,
  addonLookupKey,
  addonDisplayName,
} from './price-provisioning';

describe('lookup key helpers', () => {
  it('builds plan lookup keys (lowercased, monthly)', () => {
    expect(planLookupKey('PRO')).toBe('plan_pro_monthly');
    expect(planLookupKey('BASIC')).toBe('plan_basic_monthly');
    expect(planLookupKey('MAX')).toBe('plan_max_monthly');
  });

  it('builds addon lookup keys as addon_<type>_<plan> lowercased', () => {
    expect(addonLookupKey('PRO', 'EXTRA_CHANNEL')).toBe(
      'addon_extra_channel_pro',
    );
    expect(addonLookupKey('MAX', 'AI_TOKENS')).toBe('addon_ai_tokens_max');
  });

  it('produces human display names for all addon types', () => {
    expect(addonDisplayName('EXTRA_CHANNEL', 'PRO')).toBe('Extra Channel (PRO)');
    expect(addonDisplayName('AI_TOKENS', 'MAX')).toBe('AI Tokens (MAX)');
    expect(addonDisplayName('UNKNOWN_X', 'PRO')).toBe('UNKNOWN_X (PRO)');
  });
});
