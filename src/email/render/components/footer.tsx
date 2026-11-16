import { Column, Link, Row, Section, Text } from '@react-email/components';
import type { CSSProperties } from 'react';
import { Fragment } from 'react';
import type { FooterContext } from '../../templates/types';
import { EMAIL_COLORS } from '../palette';

const LINE: CSSProperties = {
  color: EMAIL_COLORS.muted,
  fontSize: '12px',
  lineHeight: '20px',
  textAlign: 'center',
  margin: '0 0 4px',
};

/** Three centred lines under the card: why you got it, links, the brand. */
export function EmailFooter({ reason, links }: FooterContext) {
  return (
    <Section>
      <Row>
        <Column style={{ padding: '24px 16px 0' }}>
          <Text style={LINE}>{reason}</Text>
          {links.length > 0 ? (
            <Text style={LINE}>
              {links.map((link, i) => (
                <Fragment key={`${link.label}-${i}`}>
                  {i > 0 ? ' · ' : null}
                  <Link
                    href={link.href}
                    style={{
                      color: EMAIL_COLORS.body,
                      textDecoration: 'none',
                    }}
                  >
                    {link.label}
                  </Link>
                </Fragment>
              ))}
            </Text>
          ) : null}
          <Text style={LINE}>Schedura · schedura.ai</Text>
        </Column>
      </Row>
    </Section>
  );
}
