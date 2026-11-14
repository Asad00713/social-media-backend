import {
  Body,
  Container,
  Head,
  Html,
  Img,
  Preview,
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

/**
 * At 375 the card goes almost edge to edge and the button fills the width
 * (Figma A1·m, C1·m, C3·m). Clients that drop `<style>` keep the desktop look.
 */
const RESPONSIVE_CSS = `
@media only screen and (max-width: 480px) {
  .email-shell { padding: 12px 12px 24px !important; }
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
        <Container
          className="email-shell"
          style={{ maxWidth: '600px', width: '100%', padding: '32px 20px' }}
        >
          <Section
            className="email-card"
            style={{
              backgroundColor: EMAIL_COLORS.card,
              border: `1px solid ${EMAIL_COLORS.border}`,
              borderRadius: '12px',
              padding: '32px',
            }}
          >
            <Img src={logoUrl} width="120" height="22" alt="Schedura" />
            {children}
          </Section>
          <EmailFooter reason={footer.reason} links={footer.links} />
        </Container>
      </Body>
    </Html>
  );
}
