import { SubscriptionLookupService } from './subscription-lookup.service';

describe('SubscriptionLookupService.toAddonQuantities', () => {
  it('maps subscription items onto add-on quantities', () => {
    const items = [
      { itemType: 'BASE_PLAN', quantity: 1 },
      { itemType: 'EXTRA_CHANNEL', quantity: 3 },
      { itemType: 'EXTRA_MEMBER', quantity: 2 },
      { itemType: 'EXTRA_WORKSPACE', quantity: 1 },
    ];
    expect(SubscriptionLookupService.toAddonQuantities(items, {})).toEqual({
      extraChannels: 3,
      extraMembers: 2,
      extraWorkspaces: 1,
      extraAiTokens: 0,
    });
  });

  it('multiplies an AI-token pack by its units-per-quantity', () => {
    const items = [{ itemType: 'EXTRA_AI_TOKENS', quantity: 2 }];
    expect(
      SubscriptionLookupService.toAddonQuantities(items, {
        EXTRA_AI_TOKENS: 5000,
      }),
    ).toEqual({
      extraChannels: 0,
      extraMembers: 0,
      extraWorkspaces: 0,
      extraAiTokens: 10000,
    });
  });

  it('ignores an unrecognised item type rather than throwing', () => {
    const items = [{ itemType: 'SOMETHING_NEW', quantity: 9 }];
    expect(SubscriptionLookupService.toAddonQuantities(items, {})).toEqual({
      extraChannels: 0,
      extraMembers: 0,
      extraWorkspaces: 0,
      extraAiTokens: 0,
    });
  });

  it('returns all zeroes for an empty item list', () => {
    expect(SubscriptionLookupService.toAddonQuantities([], {})).toEqual({
      extraChannels: 0,
      extraMembers: 0,
      extraWorkspaces: 0,
      extraAiTokens: 0,
    });
  });
});
