import { Hr, Link, Text } from '@react-email/components';
import { EMAIL_COLORS } from '../palette';

interface FallbackLinkProps {
  href: string;
}

/** "Button not working?" line with the raw URL, then the divider before the note. */
export function FallbackLink({ href }: FallbackLinkProps) {
  return (
    <>
      <Text
        style={{
          color: EMAIL_COLORS.muted,
          fontSize: '14px',
          lineHeight: '22px',
          margin: '0 0 16px',
        }}
      >
        Button not working? Paste this link into your browser:
        <br />
        <Link
          href={href}
          style={{ color: EMAIL_COLORS.link, wordBreak: 'break-all' }}
        >
          {href}
        </Link>
      </Text>
      <Hr style={{ borderColor: EMAIL_COLORS.border, margin: '0 0 16px' }} />
    </>
  );
}
