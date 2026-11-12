import { isAudienceRefreshable } from './refreshable';

describe('isAudienceRefreshable', () => {
  it.each([
    [true, 'connected', true],
    [false, 'connected', false],
    [true, 'expired', false],
    [true, 'revoked', false],
    [false, 'expired', false],
  ])(
    'isActive=%s connectionStatus=%s is %s',
    (isActive, connectionStatus, expected) => {
      expect(isAudienceRefreshable({ isActive, connectionStatus })).toBe(
        expected,
      );
    },
  );
});
