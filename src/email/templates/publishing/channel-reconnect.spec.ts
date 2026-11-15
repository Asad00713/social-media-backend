import { renderEmail } from '../../render/render-email';
import { EMAIL_COLORS } from '../../render/palette';
import type { RenderContext } from '../types';
import {
  channelReconnect,
  type ChannelReconnectProps,
} from './channel-reconnect';
import { PUBLISHING_TEMPLATES } from './index';

const ctx: RenderContext = {
  assetBaseUrl: 'https://app.test/email',
  footer: {
    reason: 'Why line',
    links: [{ label: 'Privacy', href: 'https://s.test/privacy' }],
  },
};

const NASTY = 'A & <B> "q"';
const NASTY_ESCAPED = 'A &amp; &lt;B&gt; &quot;q&quot;';

const expired: ChannelReconnectProps = channelReconnect.fixture;
const expiring = channelReconnect.variants?.expiring as ChannelReconnectProps;

describe('C2 channel-reconnect', () => {
  it('is registered in the publishing group on channel_health', () => {
    expect(PUBLISHING_TEMPLATES).toContain(channelReconnect);
    expect(channelReconnect.category).toBe('publishing');
    expect(channelReconnect.event).toBe('channel_health');
    expect(channelReconnect.footer).toBe('notification');
  });

  describe('expired', () => {
    it('has the Figma subject, preheader, heading and button', async () => {
      const r = await renderEmail(channelReconnect, expired, ctx);
      expect(r.subject).toBe('Reconnect Instagram to keep posting');
      expect(r.preheader).toBe(
        '4 scheduled posts are waiting on @lumierecafe.',
      );
      expect(r.html).toContain('Reconnect Instagram to keep posting');
      expect(r.html).toContain('Reconnect Instagram');
      expect(r.html).toContain(expired.reconnectUrl);
      expect(r.html).toContain(
        'Only owners and admins can reconnect a channel.',
      );
    });

    it('has the card: handle alone, then network, type and when', async () => {
      const r = await renderEmail(channelReconnect, expired, ctx);
      expect(r.html).toContain('@lumierecafe');
      expect(r.html).toContain(
        'Instagram Business · disconnected today, 9:12 AM',
      );
      expect(r.html).not.toContain('@lumierecafe · ');
      expect(r.html).toContain('Needs you');
    });

    it('explains why, naming the company that asks for confirmation', async () => {
      const r = await renderEmail(channelReconnect, expired, ctx);
      expect(r.text).toContain(
        "Instagram ended Schedura's access. This usually happens after a password change, or when Meta asks you to confirm your account.",
      );
    });

    it.each([
      ['facebook', 'Meta'],
      ['threads', 'Meta'],
      ['whatsapp', 'Meta'],
      ['youtube', 'Google'],
      ['google_business', 'Google'],
      ['linkedin', 'LinkedIn'],
      ['twitter', 'X'],
      ['tiktok', 'TikTok'],
      ['pinterest', 'Pinterest'],
    ])('names %s as asked by %s', async (platform, company) => {
      const r = await renderEmail(
        channelReconnect,
        { ...expired, platform, platformName: 'Net' },
        ctx,
      );
      expect(r.text).toContain(`or when ${company} asks you to confirm`);
    });

    it('falls back to the network name for any other platform', async () => {
      const r = await renderEmail(
        channelReconnect,
        { ...expired, platform: 'bluesky', platformName: 'Bluesky' },
        ctx,
      );
      expect(r.text).toContain(
        "Bluesky ended Schedura's access. This usually happens after a password change, or when Bluesky asks you to confirm your account.",
      );
    });

    it('says how many posts are held and when the next one is', async () => {
      const r = await renderEmail(channelReconnect, expired, ctx);
      expect(r.text).toContain(
        "4 scheduled posts won't publish until you reconnect. The next one is Nov 15, 2026 at 6:30 PM GMT+5.",
      );
    });

    it('uses the singular for one post, in the callout and the preheader', async () => {
      const props = { ...expired, waiting: 1 };
      const r = await renderEmail(channelReconnect, props, ctx);
      expect(r.text).toContain("1 scheduled post won't publish");
      expect(r.preheader).toBe('1 scheduled post is waiting on @lumierecafe.');
    });

    it('omits the callout and falls back to the expired preheader when nothing is waiting', async () => {
      const r = await renderEmail(
        channelReconnect,
        { ...expired, waiting: 0, nextWhen: null },
        ctx,
      );
      expect(r.html).not.toContain('scheduled post');
      expect(r.html).not.toContain('publish until you reconnect');
      expect(r.preheader).toBe(
        'Instagram access for @lumierecafe has expired.',
      );
      expect(r.html).toContain('Reconnect Instagram');
    });

    it('uses amber, not danger, for the badge and the callout', async () => {
      const r = await renderEmail(channelReconnect, expired, ctx);
      expect(r.html).toContain(EMAIL_COLORS.warnBg);
      expect(r.html).toContain(EMAIL_COLORS.warnText);
      expect(r.html).not.toContain(EMAIL_COLORS.dangerBg);
      expect(r.html).not.toContain(EMAIL_COLORS.dangerText);
      expect(r.html).toContain('icon-warning.png');
    });

    it('escapes a handle with markup', async () => {
      const r = await renderEmail(
        channelReconnect,
        { ...expired, handle: NASTY },
        ctx,
      );
      expect(r.html).toContain(NASTY_ESCAPED);
      expect(r.html).not.toContain('<B>');
    });
  });

  describe('expiring', () => {
    it('has the expiring subject, preheader, badge and warning callout', async () => {
      const r = await renderEmail(channelReconnect, expiring, ctx);
      expect(r.subject).toBe('Reconnect Instagram before Nov 22, 2026');
      expect(r.preheader).toBe(
        'Instagram access for @lumierecafe ends on Nov 22, 2026.',
      );
      expect(r.html).toContain('Expires soon');
      expect(r.html).toContain('Instagram · access ends Nov 22, 2026');
      expect(r.text).toContain(
        'Reconnect before Nov 22, 2026 so 4 scheduled posts still go out.',
      );
      expect(r.html).not.toContain('Needs you');
    });

    it('has no "ended access" paragraph', async () => {
      const r = await renderEmail(channelReconnect, expiring, ctx);
      expect(r.text).not.toContain("ended Schedura's access");
    });

    it('omits the callout when nothing is waiting', async () => {
      const r = await renderEmail(
        channelReconnect,
        { ...expiring, waiting: 0, nextWhen: null },
        ctx,
      );
      expect(r.html).not.toContain('still go out');
    });
  });

  it('keeps the subject on one line even for a hostile platform name', async () => {
    const r = await renderEmail(
      channelReconnect,
      { ...expired, platformName: 'Insta\r\nBcc: x@y.z' },
      ctx,
    );
    expect(r.subject).not.toMatch(/[\r\n]/);
  });
});
