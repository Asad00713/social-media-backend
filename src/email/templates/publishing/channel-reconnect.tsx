import { Column, Row, Section, Text } from '@react-email/components';
import { EmailButton } from '../../render/components/button';
import { Callout } from '../../render/components/callout';
import { NetworkGlyph } from '../../render/components/post-card';
import { Heading, Paragraph } from '../../render/components/text';
import { EMAIL_COLORS } from '../../render/palette';
import { defineTemplate } from '../define-template';

export interface ChannelReconnectProps {
  kind: 'expired' | 'expiring';
  /** The platform id (`instagram`), for the network glyph. */
  platform: string;
  platformName: string;
  handle: string;
  accountType: string;
  /** The card's second line, e.g. `Instagram · disconnected today, 9:12 AM`. */
  statusLine: string;
  /** Scheduled posts that target this channel. */
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

const BADGE_BACKGROUND: Record<ChannelReconnectProps['kind'], string> = {
  expired: EMAIL_COLORS.dangerBg,
  expiring: EMAIL_COLORS.warnBg,
};

const BADGE_COLOR: Record<ChannelReconnectProps['kind'], string> = {
  expired: EMAIL_COLORS.dangerText,
  expiring: EMAIL_COLORS.heading,
};

const posts = (n: number) => `${n} scheduled ${n === 1 ? 'post' : 'posts'}`;

/** C2: a PostCard-style box for the channel: network, handle, status and a badge. */
function ChannelCard(p: ChannelReconnectProps) {
  return (
    <Section
      style={{
        border: `1px solid ${EMAIL_COLORS.border}`,
        borderRadius: '12px',
        margin: '0 0 24px',
      }}
    >
      <Row>
        <Column style={{ padding: '16px' }}>
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
              {p.accountType ? (
                <span
                  style={{
                    color: EMAIL_COLORS.muted,
                    fontWeight: 400,
                    verticalAlign: 'middle',
                  }}
                >
                  {` · ${p.accountType}`}
                </span>
              ) : null}
            </Column>
            <Column align="right" style={{ whiteSpace: 'nowrap' }}>
              <span
                style={{
                  backgroundColor: BADGE_BACKGROUND[p.kind],
                  color: BADGE_COLOR[p.kind],
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
              margin: '8px 0 0',
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
        {`Reconnect before ${p.endsOn} so ${posts(p.waiting)} still ${p.waiting === 1 ? 'goes' : 'go'} out.`}
      </Callout>
    );
  }
  return (
    <Callout tone="danger">
      {`${posts(p.waiting)} won't publish until you reconnect.${p.nextWhen ? ` The next one is ${p.nextWhen}.` : ''}`}
    </Callout>
  );
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
      : `${p.platformName} access for ${p.handle} has expired.`,
  Body: (p) => (
    <>
      <Heading>
        {p.kind === 'expiring'
          ? `Reconnect ${p.platformName} before ${p.endsOn}`
          : `Reconnect ${p.platformName} to keep posting`}
      </Heading>
      <ChannelCard {...p} />
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
    accountType: 'Business account',
    statusLine: 'Instagram · disconnected today, 9:12 AM',
    waiting: 4,
    nextWhen: 'Oct 26, 2026 at 6:00 PM GMT+5',
    reconnectUrl: 'https://app.schedura.ai/w/demo/channels',
  },
  variants: {
    expiring: {
      kind: 'expiring',
      platform: 'instagram',
      platformName: 'Instagram',
      handle: '@lumierecafe',
      accountType: 'Business account',
      statusLine: 'Instagram · access ends Nov 2, 2026',
      waiting: 4,
      nextWhen: 'Oct 26, 2026 at 6:00 PM GMT+5',
      endsOn: 'Nov 2, 2026',
      reconnectUrl: 'https://app.schedura.ai/w/demo/channels',
    },
  },
});
