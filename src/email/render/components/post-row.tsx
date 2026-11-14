import { Column, Img, Row, Section, Text } from '@react-email/components';
import { EMAIL_COLORS } from '../palette';
import { displayCaption, NetworkGlyph } from './post-card';

interface PostRowProps {
  platform: string;
  handle: string;
  when: string;
  title: string;
  /** Why it failed, shown in red. */
  reason: string;
  thumbnailUrl?: string | null;
}

/** One line in a list of posts (C1a): thumbnail, title, network and the reason. */
export function PostRow({
  platform,
  handle,
  when,
  title,
  reason,
  thumbnailUrl,
}: PostRowProps) {
  return (
    <Section style={{ borderBottom: `1px solid ${EMAIL_COLORS.border}` }}>
      <Row>
        {thumbnailUrl ? (
          <Column
            width="56"
            style={{ width: '56px', padding: '12px 0', verticalAlign: 'top' }}
          >
            <Img
              src={thumbnailUrl}
              width="44"
              height="44"
              alt=""
              style={{ borderRadius: '6px', objectFit: 'cover' }}
            />
          </Column>
        ) : null}
        <Column style={{ padding: '12px 0', verticalAlign: 'top' }}>
          <Text
            style={{
              color: EMAIL_COLORS.heading,
              fontSize: '14px',
              lineHeight: '20px',
              fontWeight: 600,
              margin: 0,
              wordBreak: 'break-word',
            }}
          >
            {displayCaption(title)}
          </Text>
          <Text
            style={{
              color: EMAIL_COLORS.muted,
              fontSize: '13px',
              lineHeight: '22px',
              margin: 0,
            }}
          >
            <NetworkGlyph platform={platform} size={14} />
            <span style={{ verticalAlign: 'middle' }}>
              {handle} · {when}
            </span>
          </Text>
          <Text
            style={{
              color: EMAIL_COLORS.dangerText,
              fontSize: '13px',
              lineHeight: '20px',
              margin: 0,
            }}
          >
            {reason}
          </Text>
        </Column>
      </Row>
    </Section>
  );
}
