import { renderEmail } from '../../render/render-email';
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
    it('has the Figma subject, heading, badge and button', async () => {
      const r = await renderEmail(channelReconnect, expired, ctx);
      expect(r.subject).toBe('Reconnect Instagram to keep posting');
      expect(r.html).toContain('Reconnect Instagram to keep posting');
      expect(r.html).toContain('Needs you');
      expect(r.html).toContain('Reconnect Instagram');
      expect(r.html).toContain('@lumierecafe');
      expect(r.html).toContain('Business account');
      expect(r.html).toContain('Instagram · disconnected today, 9:12 AM');
      expect(r.html).toContain(expired.reconnectUrl);
      expect(r.html).toContain(
        'Only owners and admins can reconnect a channel.',
      );
    });

    it('says how many posts are held and when the next one is', async () => {
      const r = await renderEmail(channelReconnect, expired, ctx);
      expect(r.text).toContain(
        "4 scheduled posts won't publish until you reconnect. The next one is Oct 26, 2026 at 6:00 PM GMT+5.",
      );
    });

    it('uses the singular for one post', async () => {
      const r = await renderEmail(
        channelReconnect,
        { ...expired, waiting: 1 },
        ctx,
      );
      expect(r.text).toContain("1 scheduled post won't publish");
    });

    it('omits the callout when nothing is waiting', async () => {
      const r = await renderEmail(
        channelReconnect,
        { ...expired, waiting: 0, nextWhen: null },
        ctx,
      );
      expect(r.html).not.toContain('scheduled post');
      expect(r.html).not.toContain('publish until you reconnect');
      expect(r.html).toContain('Reconnect Instagram');
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
      expect(r.subject).toBe('Reconnect Instagram before Nov 2, 2026');
      expect(r.preheader).toBe(
        'Instagram access for @lumierecafe ends on Nov 2, 2026.',
      );
      expect(r.html).toContain('Expires soon');
      expect(r.html).toContain('Instagram · access ends Nov 2, 2026');
      expect(r.text).toContain(
        'Reconnect before Nov 2, 2026 so 4 scheduled posts still go out.',
      );
      expect(r.html).not.toContain('Needs you');
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
