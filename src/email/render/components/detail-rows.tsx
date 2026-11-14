import { Column, Row, Section, Text } from '@react-email/components';
import { EMAIL_COLORS } from '../palette';

interface DetailRow {
  label: string;
  value: string;
}

interface DetailRowsProps {
  /** Optional heading inside the panel, e.g. `What changes on Free`. */
  title?: string;
  rows: DetailRow[];
}

/** Label/value facts in a grey panel: grey label, bold value. */
export function DetailRows({ title, rows }: DetailRowsProps) {
  return (
    <Section
      style={{
        backgroundColor: EMAIL_COLORS.codeBg,
        borderRadius: '8px',
        margin: '0 0 24px',
      }}
    >
      <Row>
        <Column style={{ padding: '12px 16px' }}>
          {title ? (
            <Text
              style={{
                color: EMAIL_COLORS.heading,
                fontSize: '14px',
                lineHeight: '20px',
                fontWeight: 600,
                margin: '0 0 4px',
              }}
            >
              {title}
            </Text>
          ) : null}
          {rows.map((row, i) => (
            <Row key={`${row.label}-${i}`}>
              <Column
                width="110"
                style={{
                  width: '110px',
                  color: EMAIL_COLORS.muted,
                  fontSize: '14px',
                  lineHeight: '20px',
                  padding: '5px 12px 5px 0',
                  verticalAlign: 'top',
                }}
              >
                {row.label}
              </Column>
              <Column
                style={{
                  color: EMAIL_COLORS.heading,
                  fontSize: '14px',
                  lineHeight: '20px',
                  fontWeight: 600,
                  padding: '5px 0',
                  verticalAlign: 'top',
                  wordBreak: 'break-word',
                }}
              >
                {row.value}
              </Column>
            </Row>
          ))}
        </Column>
      </Row>
    </Section>
  );
}
