import { Column, Row, Section } from '@react-email/components';
import type { CSSProperties } from 'react';
import { EMAIL_COLORS } from '../palette';

interface Party {
  initials: string;
  name: string;
}

interface PeopleProps {
  /** The person, shown as a round avatar. */
  from: Party;
  /** The workspace, shown as a square tile. */
  to: Party;
}

const TILE: CSSProperties = {
  width: '44px',
  height: '44px',
  fontSize: '14px',
  lineHeight: '44px',
  fontWeight: 600,
  textAlign: 'center',
};

/** Avatar → workspace tile, above the B1/B2 heading. */
export function People({ from, to }: PeopleProps) {
  return (
    <Section style={{ margin: '24px 0 0' }}>
      <Row style={{ width: 'auto' }} align="left">
        <Column
          title={from.name}
          style={{
            ...TILE,
            borderRadius: '22px',
            backgroundColor: EMAIL_COLORS.infoBg,
            color: EMAIL_COLORS.primary,
          }}
        >
          {from.initials}
        </Column>
        <Column
          style={{
            width: '36px',
            textAlign: 'center',
            color: EMAIL_COLORS.muted,
            fontSize: '16px',
          }}
        >
          ›
        </Column>
        <Column
          title={to.name}
          style={{
            ...TILE,
            borderRadius: '8px',
            backgroundColor: EMAIL_COLORS.heading,
            color: EMAIL_COLORS.onPrimary,
          }}
        >
          {to.initials}
        </Column>
      </Row>
    </Section>
  );
}
