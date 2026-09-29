import {
  AVATAR_COLORS,
  pickAvatarColor,
  resolveAvatarColor,
} from './avatar-colors';

/**
 * A user's avatar colour is assigned once and then never recomputed, which is
 * the whole point: it is how colleagues recognise someone in a list. These
 * guard the two ways that can break — picking something the frontend cannot
 * draw, and failing to cope with a value that predates the column.
 */
describe('avatar colours', () => {
  describe('pickAvatarColor', () => {
    it('only ever returns a key from the palette', () => {
      for (let i = 0; i < 200; i += 1) {
        expect(AVATAR_COLORS).toContain(pickAvatarColor());
      }
    });

    // Not a randomness test — a check that it is not pinned to one value,
    // which would put a whole workspace in the same colour.
    it('spreads across the palette', () => {
      const seen = new Set(
        Array.from({ length: 200 }, () => pickAvatarColor()),
      );
      expect(seen.size).toBeGreaterThan(1);
    });
  });

  describe('resolveAvatarColor', () => {
    it('keeps a stored key', () => {
      expect(resolveAvatarColor('violet')).toBe('violet');
    });

    it('falls back for an account created before colours existed', () => {
      expect(AVATAR_COLORS).toContain(resolveAvatarColor(null));
      expect(AVATAR_COLORS).toContain(resolveAvatarColor(undefined));
    });

    it('falls back for a retired key', () => {
      expect(AVATAR_COLORS).toContain(resolveAvatarColor('chartreuse'));
    });

    // Deliberately fixed, not random: a random fallback would give the same
    // user a different colour on every page load.
    it('resolves the same way every time', () => {
      expect(resolveAvatarColor(null)).toBe(resolveAvatarColor(null));
      expect(resolveAvatarColor('nope')).toBe(resolveAvatarColor('nope'));
    });
  });
});
