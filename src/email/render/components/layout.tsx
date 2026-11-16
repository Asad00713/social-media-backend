import {
  Body,
  Column,
  Container,
  Head,
  Html,
  Img,
  Preview,
  Row,
  Section,
} from '@react-email/components';
import type { ReactNode } from 'react';
import type { FooterContext } from '../../templates/types';
import { useAssetUrl } from '../email-context';
import { EMAIL_COLORS, EMAIL_FONT } from '../palette';
import { EmailFooter } from './footer';

interface EmailLayoutProps {
  /** Inbox preview text after the subject (React Email `<Preview>`). */
  preheader: string;
  footer: FooterContext;
  children: ReactNode;
}

/** The column width. Fixed, because Outlook for Windows ignores `max-width`. */
const SHELL_WIDTH = 600;

/** The card's inner padding at 600 (Figma A1, C1: 40). */
const CARD_PADDING = 40;

/**
 * Below the column width the shell follows the screen. At 375 the card goes
 * almost edge to edge with 20 px inside it, and the button fills the width
 * (measured on Figma A1·m, C1·m, C3·m). Clients that drop `<style>` keep the
 * desktop look. Padding sits on cells, never on tables: Outlook for Windows
 * ignores table padding.
 */
const RESPONSIVE_CSS = `
@media only screen and (max-width: ${SHELL_WIDTH + 40}px) {
  .email-shell { width: 100% !important; }
}
@media only screen and (max-width: 480px) {
  .email-gutter { padding: 12px 12px 24px !important; }
  .email-card { padding: 20px !important; }
  .email-button { display: block !important; }
}
`;

/** The 600 px column: logo and content in a white card, footer under it. */
export function EmailLayout({ preheader, footer, children }: EmailLayoutProps) {
  const logoUrl = useAssetUrl('logo.png');
  return (
    <Html lang="en" dir="ltr">
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
        <style>{RESPONSIVE_CSS}</style>
      </Head>
      <Preview>{preheader}</Preview>
      <Body
        style={{
          backgroundColor: EMAIL_COLORS.page,
          fontFamily: EMAIL_FONT,
          margin: 0,
          padding: 0,
        }}
      >
        <Section style={{ backgroundColor: EMAIL_COLORS.page }}>
          <Row>
            <Column className="email-gutter" style={{ padding: '32px 20px' }}>
              <Container
                className="email-shell"
                width={String(SHELL_WIDTH)}
                style={{
                  width: `${SHELL_WIDTH}px`,
                  maxWidth: `${SHELL_WIDTH}px`,
                }}
              >
                <Section
                  style={{
                    backgroundColor: EMAIL_COLORS.card,
                    border: `1px solid ${EMAIL_COLORS.border}`,
                    borderRadius: '12px',
                  }}
                >
                  <Row>
                    <Column
                      className="email-card"
                      style={{ padding: `${CARD_PADDING}px` }}
                    >
                      <Img
                        src={logoUrl}
                        width="120"
                        height="22"
                        alt="Schedura"
                      />
                      {children}
                    </Column>
                  </Row>
                </Section>
                <EmailFooter reason={footer.reason} links={footer.links} />
              </Container>
            </Column>
          </Row>
        </Section>
      </Body>
    </Html>
  );
}
