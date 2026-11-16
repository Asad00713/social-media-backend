import { Column, Row, Section, Text } from '@react-email/components';
import type { ReactNode } from 'react';
import { EMAIL_COLORS } from '../palette';

interface QuoteProps {
  /** Who and when, e.g. `Your message · Publishing · Oct 26, 10:42 AM`. */
  meta: string;
  children: ReactNode;
}

/** Someone's words, behind a left rule. */
export function Quote({ meta, children }: QuoteProps) {
  return (
    <Section style={{ margin: '0 0 24px' }}>
      <Row>
        <Column
          style={{
            borderLeft: `3px solid ${EMAIL_COLORS.border}`,
            padding: '0 0 0 16px',
          }}
        >
          <Text
            style={{
              color: EMAIL_COLORS.muted,
              fontSize: '13px',
              lineHeight: '20px',
              margin: '0 0 4px',
            }}
          >
            {meta}
          </Text>
          <Text
            style={{
              color: EMAIL_COLORS.body,
              fontSize: '16px',
              lineHeight: '24px',
              margin: 0,
              wordBreak: 'break-word',
            }}
          >
            {children}
          </Text>
        </Column>
      </Row>
    </Section>
  );
}
