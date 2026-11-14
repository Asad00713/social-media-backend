import { Heading as EmailHeading, Text } from '@react-email/components';
import type { ReactNode } from 'react';
import { EMAIL_COLORS } from '../palette';

interface TextProps {
  children: ReactNode;
}

interface ParagraphProps extends TextProps {
  /** `muted` is the small grey note under a button or fallback. */
  tone?: 'body' | 'muted';
}

/** The one H1 of an email. */
export function Heading({ children }: TextProps) {
  return (
    <EmailHeading
      as="h1"
      style={{
        color: EMAIL_COLORS.heading,
        fontSize: '24px',
        lineHeight: '32px',
        fontWeight: 600,
        margin: '24px 0 16px',
      }}
    >
      {children}
    </EmailHeading>
  );
}

export function Paragraph({ children, tone = 'body' }: ParagraphProps) {
  const isMuted = tone === 'muted';
  return (
    <Text
      style={{
        color: isMuted ? EMAIL_COLORS.muted : EMAIL_COLORS.body,
        fontSize: isMuted ? '14px' : '16px',
        lineHeight: isMuted ? '22px' : '26px',
        margin: '0 0 16px',
      }}
    >
      {children}
    </Text>
  );
}

export function Strong({ children }: TextProps) {
  return (
    <strong style={{ color: EMAIL_COLORS.heading, fontWeight: 600 }}>
      {children}
    </strong>
  );
}
