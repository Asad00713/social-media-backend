import { Column, Img, Row, Section } from '@react-email/components';
import type { ReactNode } from 'react';
import { useAssetUrl } from '../email-context';
import { EMAIL_COLORS } from '../palette';

type CalloutTone = 'info' | 'warning' | 'danger';

interface CalloutProps {
  tone: CalloutTone;
  children: ReactNode;
}

const BACKGROUNDS: Record<CalloutTone, string> = {
  info: EMAIL_COLORS.infoBg,
  warning: EMAIL_COLORS.warnBg,
  danger: EMAIL_COLORS.dangerBg,
};

/** A tinted block with a leading icon: info, warning or danger. */
export function Callout({ tone, children }: CalloutProps) {
  const iconUrl = useAssetUrl(`icon-${tone}.png`);
  return (
    <Section
      style={{
        backgroundColor: BACKGROUNDS[tone],
        borderRadius: '8px',
        margin: '0 0 24px',
      }}
    >
      <Row>
        <Column
          style={{
            width: '28px',
            padding: '14px 0 0 16px',
            verticalAlign: 'top',
          }}
        >
          <Img src={iconUrl} width="16" height="16" alt="" />
        </Column>
        <Column
          style={{
            color: EMAIL_COLORS.heading,
            fontSize: '14px',
            lineHeight: '22px',
            padding: '11px 16px 11px 0',
            verticalAlign: 'top',
          }}
        >
          {children}
        </Column>
      </Row>
    </Section>
  );
}
