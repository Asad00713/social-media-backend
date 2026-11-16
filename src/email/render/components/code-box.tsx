import { Section, Text } from '@react-email/components';
import { EMAIL_COLORS } from '../palette';

interface CodeBoxProps {
  code: string;
}

/** `482913` reads as `482 913`; any other shape is shown as given. */
function groupCode(code: string): string {
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** The large one-time code in a bordered chip. */
export function CodeBox({ code }: CodeBoxProps) {
  return (
    <Section
      className="email-code"
      style={{
        backgroundColor: EMAIL_COLORS.codeBg,
        border: `1px solid ${EMAIL_COLORS.border}`,
        borderRadius: '8px',
        margin: '0 0 24px',
      }}
    >
      <Text
        style={{
          color: EMAIL_COLORS.heading,
          fontFamily:
            "'SFMono-Regular', Menlo, Consolas, 'Courier New', monospace",
          fontSize: '32px',
          lineHeight: '40px',
          letterSpacing: '6px',
          textAlign: 'center',
          margin: 0,
          padding: '16px 0',
        }}
      >
        {groupCode(code)}
      </Text>
    </Section>
  );
}
