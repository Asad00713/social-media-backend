import { Column, Row, Section, Text } from '@react-email/components';
import { EmailButton } from '../../render/components/button';
import { Callout } from '../../render/components/callout';
import { NetworkGlyph } from '../../render/components/post-card';
import { Heading, Paragraph } from '../../render/components/text';
import { EMAIL_COLORS } from '../../render/palette';
import { defineTemplate } from '../define-template';

export interface ChannelReconnectProps {
  kind: 'expired' | 'expiring';
  /** The platform id (`instagram`), for the network glyph and the company. */
  platform: string;
  platformName: string;
  handle: string;
  /** The card's second line, e.g. `Instagram Business · disconnected today, 9:12 AM`. */
  statusLine: string;
  /** Scheduled posts that target this channel and have not gone out yet. */
  waiting: number;
  /** The earliest of them, already formatted in the workspace zone. */
  nextWhen: string | null;
  /** The last day access works, formatted; set for `expiring`. */
  endsOn?: string;
  reconnectUrl: string;
}

const BADGE_LABEL: Record<ChannelReconnectProps['kind'], string> = {
  expired: 'Needs you',
  expiring: 'Expires soon',
};

/** Who asks you to confirm your account, by platform id. */
const COMPANY: Record<string, string> = {
  instagram: 'Meta',
  facebook: 'Meta',
  threads: 'Meta',
  whatsapp: 'Meta',
  youtube: 'Google',
  google_business: 'Google',
  linkedin: 'LinkedIn',
  twitter: 'X',
  tiktok: 'TikTok',
  pinterest: 'Pinterest',
};

const scheduledPosts = (n: number) =>
  `${n} scheduled ${n === 1 ? 'post' : 'posts'}`;

/** C2: a grey panel for the channel: network, handle, status line and a badge. */
function ChannelCard(p: ChannelReconnectProps) {
  return (
    <Section
      style={{
        backgroundColor: EMAIL_COLORS.codeBg,
        borderRadius: '8px',
        margin: '0 0 24px',
      }}
    >
      <Row>
        <Column style={{ padding: '12px 16px' }}>
          <Row>
            <Column
              style={{
                color: EMAIL_COLORS.heading,
                fontSize: '14px',
                lineHeight: '20px',
                fontWeight: 600,
              }}
            >
              <NetworkGlyph platform={p.platform} size={16} />
              <span style={{ verticalAlign: 'middle' }}>{p.handle}</span>
            </Column>
            <Column align="right" style={{ whiteSpace: 'nowrap' }}>
              <span
                style={{
                  backgroundColor: EMAIL_COLORS.warnBg,
                  color: EMAIL_COLORS.warnText,
                  borderRadius: '999px',
                  fontSize: '12px',
                  lineHeight: '20px',
                  fontWeight: 600,
                  padding: '2px 10px',
                }}
              >
                {BADGE_LABEL[p.kind]}
              </span>
            </Column>
          </Row>
          <Text
            style={{
              color: EMAIL_COLORS.muted,
              fontSize: '13px',
              lineHeight: '20px',
              margin: '4px 0 0',
            }}
          >
            {p.statusLine}
          </Text>
        </Column>
      </Row>
    </Section>
  );
}

/** What is at stake, or null when nothing is queued on the channel. */
function stakes(p: ChannelReconnectProps) {
  if (p.waiting <= 0) return null;
  if (p.kind === 'expiring') {
    return (
      <Callout tone="warning">
        {`Reconnect before ${p.endsOn} so ${scheduledPosts(p.waiting)} still ${p.waiting === 1 ? 'goes' : 'go'} out.`}
      </Callout>
    );
  }
  return (
    <Callout tone="warning">
      {`${scheduledPosts(p.waiting)} won't publish until you reconnect.${p.nextWhen ? ` The next one is ${p.nextWhen}.` : ''}`}
    </Callout>
  );
}

function expiredPreheader(p: ChannelReconnectProps): string {
  if (p.waiting <= 0) {
    return `${p.platformName} access for ${p.handle} has expired.`;
  }
  return `${scheduledPosts(p.waiting)} ${p.waiting === 1 ? 'is' : 'are'} waiting on ${p.handle}.`;
}

/**
 * C2: a channel's connection expired (or will soon). Sent to the owner and
 * admins under Notifications > Channel disconnected; only they can reconnect.
 */
export const channelReconnect = defineTemplate<ChannelReconnectProps>({
  id: 'channel-reconnect',
  category: 'publishing',
  event: 'channel_health',
  footer: 'notification',
  subject: (p) =>
    p.kind === 'expiring'
      ? `Reconnect ${p.platformName} before ${p.endsOn}`
      : `Reconnect ${p.platformName} to keep posting`,
  preheader: (p) =>
    p.kind === 'expiring'
      ? `${p.platformName} access for ${p.handle} ends on ${p.endsOn}.`
      : expiredPreheader(p),
  Body: (p) => (
    <>
      <Heading>
        {p.kind === 'expiring'
          ? `Reconnect ${p.platformName} before ${p.endsOn}`
          : `Reconnect ${p.platformName} to keep posting`}
      </Heading>
      <ChannelCard {...p} />
      {p.kind === 'expired' ? (
        <Paragraph>
          {`${p.platformName} ended Schedura's access. This usually happens after a password change, or when ${COMPANY[p.platform] ?? p.platformName} asks you to confirm your account.`}
        </Paragraph>
      ) : null}
      {stakes(p)}
      <EmailButton href={p.reconnectUrl} variant="primary">
        {`Reconnect ${p.platformName}`}
      </EmailButton>
      <Paragraph tone="muted">
        Only owners and admins can reconnect a channel.
      </Paragraph>
    </>
  ),
  fixture: {
    kind: 'expired',
    platform: 'instagram',
    platformName: 'Instagram',
    handle: '@lumierecafe',
    statusLine: 'Instagram Business · disconnected today, 9:12 AM',
    waiting: 4,
    nextWhen: 'Nov 15, 2026 at 6:30 PM GMT+5',
    reconnectUrl: 'https://app.schedura.ai/w/demo/channels',
  },
  variants: {
    expiring: {
      kind: 'expiring',
      platform: 'instagram',
      platformName: 'Instagram',
      handle: '@lumierecafe',
      statusLine: 'Instagram · access ends Nov 22, 2026',
      waiting: 4,
      nextWhen: 'Nov 15, 2026 at 6:30 PM GMT+5',
      endsOn: 'Nov 22, 2026',
      reconnectUrl: 'https://app.schedura.ai/w/demo/channels',
    },
  },
});
