import { Column, Row, Section, Text } from '@react-email/components';
import { EMAIL_COLORS } from '../palette';

interface Step {
  title: string;
  body: string;
}

interface StepsProps {
  steps: Step[];
}

/** Numbered first steps (F1): a number badge, a title and one line. */
export function Steps({ steps }: StepsProps) {
  return (
    <Section style={{ margin: '0 0 16px' }}>
      {steps.map((step, i) => (
        <Row key={step.title} style={{ marginBottom: '12px' }}>
          <Column style={{ width: '42px', verticalAlign: 'top' }}>
            <Text
              style={{
                width: '28px',
                height: '28px',
                borderRadius: '14px',
                backgroundColor: EMAIL_COLORS.infoBg,
                color: EMAIL_COLORS.primary,
                fontSize: '13px',
                lineHeight: '28px',
                fontWeight: 600,
                textAlign: 'center',
                margin: 0,
              }}
            >
              {i + 1}
            </Text>
          </Column>
          <Column style={{ verticalAlign: 'top' }}>
            <Text
              style={{
                color: EMAIL_COLORS.heading,
                fontSize: '15px',
                lineHeight: '24px',
                fontWeight: 600,
                margin: 0,
              }}
            >
              {step.title}
            </Text>
            <Text
              style={{
                color: EMAIL_COLORS.muted,
                fontSize: '14px',
                lineHeight: '22px',
                margin: 0,
              }}
            >
              {step.body}
            </Text>
          </Column>
        </Row>
      ))}
    </Section>
  );
}
