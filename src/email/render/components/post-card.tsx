import { Column, Img, Row, Section, Text } from '@react-email/components';
import { useAssetUrl } from '../email-context';
import { EMAIL_COLORS } from '../palette';

interface PostCardProps {
  platform: string;
  handle: string;
  when: string;
  caption: string;
  thumbnailUrl?: string | null;
}

interface NetworkGlyphProps {
  platform: string;
  size: number;
}

const CAPTION_LIMIT = 280;

/** Platforms with a shipped `network-{platform}.png`, and their alt text. */
const NETWORK_LABELS: Record<string, string> = {
  twitter: 'X',
  instagram: 'Instagram',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  threads: 'Threads',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  pinterest: 'Pinterest',
  google_business: 'Google Business Profile',
  reddit: 'Reddit',
};

/** A platform's display name ('twitter' -> 'X'); unknown ones are title-cased. */
export function networkName(platform: string): string {
  if (Object.hasOwn(NETWORK_LABELS, platform)) return NETWORK_LABELS[platform];
  return platform
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Post text as an email shows it: blank reads `(No caption)`, and over 280
 * characters keeps the first 279 plus `…`. Counts code points so an emoji is
 * never cut in half.
 */
export function displayCaption(caption: string): string {
  const trimmed = caption.trim();
  if (!trimmed) return '(No caption)';
  const chars = Array.from(trimmed);
  if (chars.length <= CAPTION_LIMIT) return trimmed;
  return `${chars.slice(0, CAPTION_LIMIT - 1).join('')}…`;
}

/** Full-colour network logo; an unknown platform gets the generic glyph. */
export function NetworkGlyph({ platform, size }: NetworkGlyphProps) {
  const label = Object.hasOwn(NETWORK_LABELS, platform)
    ? NETWORK_LABELS[platform]
    : undefined;
  const src = useAssetUrl(
    label ? `network-${platform}.png` : 'network-generic.png',
  );
  return (
    <Img
      src={src}
      width={String(size)}
      height={String(size)}
      alt={label ?? ''}
      style={{
        display: 'inline-block',
        verticalAlign: 'middle',
        marginRight: '6px',
      }}
    />
  );
}

/** One post: network, handle and time, then the thumbnail and caption. */
export function PostCard({
  platform,
  handle,
  when,
  caption,
  thumbnailUrl,
}: PostCardProps) {
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
            {/* The icon and handle never part; a long time wraps instead. */}
            <Column
              data-post-card-handle=""
              style={{
                color: EMAIL_COLORS.heading,
                fontSize: '14px',
                lineHeight: '20px',
                fontWeight: 600,
                whiteSpace: 'nowrap',
                verticalAlign: 'top',
              }}
            >
              <NetworkGlyph platform={platform} size={16} />
              <span style={{ verticalAlign: 'middle' }}>{handle}</span>
            </Column>
            <Column
              data-post-card-when=""
              align="right"
              style={{
                color: EMAIL_COLORS.muted,
                fontSize: '13px',
                lineHeight: '20px',
                paddingLeft: '12px',
                verticalAlign: 'top',
              }}
            >
              {when}
            </Column>
          </Row>
          <Row>
            {thumbnailUrl ? (
              <Column
                width="76"
                style={{
                  width: '76px',
                  paddingTop: '12px',
                  verticalAlign: 'top',
                }}
              >
                <Img
                  src={thumbnailUrl}
                  width="64"
                  height="64"
                  alt=""
                  style={{ borderRadius: '8px', objectFit: 'cover' }}
                />
              </Column>
            ) : null}
            <Column style={{ paddingTop: '12px', verticalAlign: 'top' }}>
              <Text
                style={{
                  color: EMAIL_COLORS.body,
                  fontSize: '14px',
                  lineHeight: '22px',
                  margin: 0,
                  wordBreak: 'break-word',
                }}
              >
                {displayCaption(caption)}
              </Text>
            </Column>
          </Row>
        </Column>
      </Row>
    </Section>
  );
}
