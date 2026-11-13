import { ConflictException } from '@nestjs/common';
import { channelLimitReached } from '../../../billing/services/channel-limit.error';
import { connectLinkError } from './connect-link-errors';
import {
  callbackTarget,
  connectLinkIdOf,
  linkErrorCodeOf,
} from './callback-target';

const FE = 'https://app.schedura.test';
const TOKEN = 'Zk3v_-Q9pLmN0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123';

describe('callbackTarget', () => {
  describe('team connect (no link): the URLs the callback has always built', () => {
    const t = callbackTarget({ frontendUrl: FE, linkRaw: null });
    const frontendUrl = FE;
    const enc = encodeURIComponent;

    it('is not a link', () => {
      expect(t.isLink).toBe(false);
    });

    it('success equals the auto-create branches string', () => {
      const platform = 'instagram';
      const channel = { id: 42 };
      // copied from ChannelsController.oauthCallback (instagram/threads/tiktok/slack/discord)
      const today = `${frontendUrl}/channels/connect/success?platform=${platform}&channelId=${channel.id}`;
      expect(t.success('instagram', 42)).toBe(today);
    });

    it('error equals the inner per-platform catch string', () => {
      const msg = 'Instagram setup failed: boom & bust';
      // copied from the inner catches
      const today = `${frontendUrl}/channels/connect/error?error=${enc(msg)}`;
      expect(t.error(msg)).toBe(today);
      expect(t.error(msg, null)).toBe(today);
    });

    it('error equals the outer catch string, with and without a code', () => {
      const msg = 'Invalid or expired OAuth state';
      const state = 'abcdefghijklmnop';
      const description = 'State token: ' + state.substring(0, 10) + '...';
      const code: string | null = null;
      const codeParam = code ? `&code=${enc(code)}` : '';
      // copied from the outer catch
      const today = `${frontendUrl}/channels/connect/error?error=${enc(msg)}&description=${enc(description)}${codeParam}`;
      expect(t.error(msg, null, description)).toBe(today);

      const coded = `${frontendUrl}/channels/connect/error?error=${enc(msg)}&description=${enc(description)}&code=CHANNEL_LIMIT_REACHED`;
      expect(t.error(msg, 'CHANNEL_LIMIT_REACHED', description)).toBe(coded);
    });

    it('the Twitter OAuth 1.0a literal errors are the same strings', () => {
      expect(t.error('Channel ID not found')).toBe(
        `${FE}/channels/connect/error?error=Channel%20ID%20not%20found`,
      );
      expect(t.error('OAuth state not found or expired')).toBe(
        `${FE}/channels/connect/error?error=OAuth%20state%20not%20found%20or%20expired`,
      );
    });

    it('has no selection (only a link parks a Facebook token)', () => {
      expect(() => t.selection('x')).toThrow();
    });
  });

  describe('connect link', () => {
    const t = callbackTarget({ frontendUrl: FE, linkRaw: TOKEN });

    it('is a link', () => {
      expect(t.isLink).toBe(true);
    });

    it('success goes back to /c/<token> with connected + channelId', () => {
      expect(t.success('linkedin', 7)).toBe(
        `${FE}/c/${TOKEN}?connected=linkedin&channelId=7`,
      );
    });

    it('selection goes back with ?selection=', () => {
      expect(t.selection('sel_ABC-123')).toBe(
        `${FE}/c/${TOKEN}?selection=sel_ABC-123`,
      );
    });

    it('error carries the message and the code, URL-encoded', () => {
      expect(t.error('Limit & more: 3/3', 'CHANNEL_LIMIT_REACHED')).toBe(
        `${FE}/c/${TOKEN}?error=Limit%20%26%20more%3A%203%2F3&code=CHANNEL_LIMIT_REACHED`,
      );
      expect(t.error('x', 'A&B')).toBe(`${FE}/c/${TOKEN}?error=x&code=A%26B`);
    });

    it('error without a code has no code param, and ignores a description', () => {
      expect(t.error('nope', null, 'State token: abc')).toBe(
        `${FE}/c/${TOKEN}?error=nope`,
      );
    });
  });
});

describe('linkErrorCodeOf', () => {
  it('keeps a coded refusal', () => {
    expect(linkErrorCodeOf(channelLimitReached(3, 3))).toBe(
      'CHANNEL_LIMIT_REACHED',
    );
    expect(
      linkErrorCodeOf(
        connectLinkError('LINK_REVOKED', 'This link was cancelled.'),
      ),
    ).toBe('LINK_REVOKED');
  });

  it('maps the healthy-duplicate ConflictException to ALREADY_CONNECTED', () => {
    expect(linkErrorCodeOf(new ConflictException('already connected'))).toBe(
      'ALREADY_CONNECTED',
    );
  });

  it('anything else has no code', () => {
    expect(linkErrorCodeOf(new Error('boom'))).toBeNull();
  });
});

describe('connectLinkIdOf', () => {
  it('reads a string connectLinkId only', () => {
    expect(connectLinkIdOf({ connectLinkId: 'abc' })).toBe('abc');
    expect(connectLinkIdOf({ connectLinkId: '' })).toBeNull();
    expect(connectLinkIdOf({ connectLinkId: 5 })).toBeNull();
    expect(connectLinkIdOf({})).toBeNull();
    expect(connectLinkIdOf(null)).toBeNull();
  });
});
