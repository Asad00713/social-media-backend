import { Button, Section } from '@react-email/components';
import type { CSSProperties, ReactNode } from 'react';
import { EMAIL_COLORS } from '../palette';

interface EmailButtonProps {
  href: string;
  children: ReactNode;
  /** `secondary` is the outline button for lower-stakes actions. */
  variant: 'primary' | 'secondary';
}

const BASE: CSSProperties = {
  display: 'inline-block',
  fontSize: '16px',
  lineHeight: '24px',
  fontWeight: 600,
  textAlign: 'center',
  textDecoration: 'none',
  borderRadius: '6px',
  padding: '12px 20px',
};

const VARIANTS: Record<EmailButtonProps['variant'], CSSProperties> = {
  primary: {
    backgroundColor: EMAIL_COLORS.primary,
    color: EMAIL_COLORS.onPrimary,
    border: `1px solid ${EMAIL_COLORS.primary}`,
  },
  secondary: {
    backgroundColor: EMAIL_COLORS.card,
    color: EMAIL_COLORS.heading,
    border: `1px solid ${EMAIL_COLORS.border}`,
  },
};

/** The email's single call to action. `data-email-button` lets specs count them. */
export function EmailButton({ href, children, variant }: EmailButtonProps) {
  return (
    <Section style={{ margin: '8px 0 24px' }}>
      <Button
        href={href}
        className="email-button"
        data-email-button={variant}
        style={{ ...BASE, ...VARIANTS[variant] }}
      >
        {children}
      </Button>
    </Section>
  );
}
