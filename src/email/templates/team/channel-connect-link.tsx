import { EmailButton } from '../../render/components/button';
import { FallbackLink } from '../../render/components/fallback-link';
import { People } from '../../render/components/people';
import { Heading, Paragraph, Strong } from '../../render/components/text';
import { initials } from '../../links/format-when';
import { defineTemplate } from '../define-template';

/** The networks a connect link offers, as the email names them. */
const NETWORK_LABELS: Record<string, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  pinterest: 'Pinterest',
  threads: 'Threads',
  twitter: 'X',
};

/** "Instagram, Facebook and TikTok" for a list of platform ids. */
export function formatNetworkList(ids: string[]): string {
  const names = ids.map((id) => NETWORK_LABELS[id] ?? id);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The UTC date, labelled: the server's own time zone could be a day off from
 * what the label says. `November 20, 2026 (UTC)`.
 */
export function formatLinkExpiry(expiresAt: Date): string {
  return `${expiresAt.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })} (UTC)`;
}

export interface ChannelConnectLinkProps {
  senderName: string;
  workspaceName: string;
  /** Platform ids (`instagram`, `twitter`…). */
  networks: string[];
  /** Carries the link token: send this mail inline, never through Redis. */
  connectUrl: string;
  /** Already formatted by `formatLinkExpiry`. */
  expiresOn: string;
  recipientEmail: string;
}

/**
 * "Ask someone to connect": a client connects their own social accounts into
 * a workspace through a public link. The recipient has no Schedura account,
 * so the copy says they never need one. Not in the Figma email set; built
 * from the B1 invitation's parts.
 */
export const channelConnectLink = defineTemplate<ChannelConnectLinkProps>({
  id: 'channel-connect-link',
  category: 'team',
  event: null,
  footer: 'plain',
  subject: (p) =>
    `${p.senderName} asked you to connect ${formatNetworkList(p.networks)} to ${p.workspaceName}`,
  preheader: () =>
    'You log in on each network yourself. No Schedura account needed.',
  footerReason: (p) =>
    `You get this because ${p.senderName} sent a connect link to ${p.recipientEmail}.`,
  Body: (p) => (
    <>
      <People
        from={{ initials: initials(p.senderName), name: p.senderName }}
        to={{ initials: initials(p.workspaceName), name: p.workspaceName }}
      />
      <Heading>{`Connect your accounts to ${p.workspaceName}`}</Heading>
      <Paragraph>
        <Strong>{p.senderName}</Strong> from <Strong>{p.workspaceName}</Strong>{' '}
        {`asked you to connect your ${formatNetworkList(p.networks)} to their workspace on Schedura.`}
      </Paragraph>
      <EmailButton href={p.connectUrl} variant="primary">
        Connect your accounts
      </EmailButton>
      <FallbackLink href={p.connectUrl} />
      <Paragraph tone="muted">
        {`The link works until ${p.expiresOn}. You log in on each network yourself — no Schedura account or password needed.`}
      </Paragraph>
    </>
  ),
  fixture: {
    senderName: 'M Rehman',
    workspaceName: 'Rehman Workspace',
    networks: ['instagram', 'facebook', 'tiktok'],
    connectUrl: 'https://app.schedura.ai/c/0123456789abcdef',
    expiresOn: 'November 20, 2026 (UTC)',
    recipientEmail: 'client@lumierecafe.pk',
  },
});
