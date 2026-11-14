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

const TILE_SIZE = 44;

const TILE: CSSProperties = {
  width: `${TILE_SIZE}px`,
  height: `${TILE_SIZE}px`,
  fontSize: '14px',
  lineHeight: `${TILE_SIZE}px`,
  fontWeight: 600,
  textAlign: 'center',
};

/** Avatar → workspace tile, above the B1/B2 heading. */
export function People({ from, to }: PeopleProps) {
  return (
    <Section>
      <Row>
        <Column style={{ paddingTop: '24px' }}>
          <Row>
            <Column
              width={String(TILE_SIZE)}
              height={String(TILE_SIZE)}
              title={from.name}
              style={{
                ...TILE,
                borderRadius: `${TILE_SIZE / 2}px`,
                backgroundColor: EMAIL_COLORS.primarySubtle,
                color: EMAIL_COLORS.primary,
              }}
            >
              {from.initials}
            </Column>
            <Column
              width="36"
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
              width={String(TILE_SIZE)}
              height={String(TILE_SIZE)}
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
            {/* Takes the rest of the row so the three cells stay together. */}
            <Column />
          </Row>
        </Column>
      </Row>
    </Section>
  );
}
